/**
 * Runtime memory store (Sprint 02, issue #10).
 *
 * Owns the three memory kinds that src/domain/memory declares but leaves
 * disabled (`fact`, `preference`, `hypothesis`). Lives under lib/runtimeMemory
 * rather than lib/memory to stay visibly distinct from the canonical
 * commitment/observation stores, which this module never touches.
 *
 * Three privacy properties are structural here, each with its own mechanism:
 *
 *  1. Conflicting memories stay inspectable. supersede() writes a replacement
 *     and links it to the prior record in both directions; the prior record is
 *     never rewritten in place and never removed. retrieve() shows the winner,
 *     listAll() shows the chain.
 *
 *  2. Revocation and deletion are different operations. revoke() hides a record
 *     from retrieval but keeps it for audit; deleteById()/deleteScope() remove
 *     it outright, so get() misses too.
 *
 *  3. Personal memory is tagged at write time. exportPolicy defaults to
 *     `personal_never_export` whenever the caller stays silent, which is what
 *     lib/runtimeMemory/exportPolicy.ts then enforces for fine-tuning exports.
 *
 * Both backends share one implementation of those semantics and differ only in
 * persistence. The sibling alpha stores duplicate their logic per backend,
 * which is how their in-memory prune() drifted into a no-op; privacy behaviour
 * must not be able to drift between a test store and a production store.
 *
 * No function here reads the system clock. Every timestamp is supplied by the
 * caller (`now`/`at`), so store behaviour is reproducible in tests and replays.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MEMORY_TTL_MS,
  MEMORY_RECORD_SCHEMA_VERSION,
  type CreateMemoryInput,
  type ExportPolicy,
  type MemoryExport,
  type MemoryLanguage,
  type MemoryQuery,
  type MemorySource,
  type MemoryStatus,
  type RuntimeMemoryKind,
  type RuntimeMemoryRecord,
  type RuntimeMemoryStore,
  type RuntimeMemoryStoreOptions,
} from '../../src/contracts/v1/memoryContracts';
import { isIsoTimestamp, isNonEmptyString } from '../evaluation/registry/validationPrimitives';

const MEMORY_SUBDIR = 'runtime-memory';
const MEMORY_FILE_EXT = '.memory.json';
/** Suffix of a temp file written before the atomic rename. */
const TEMP_FILE_EXT = '.tmp';
const RECORD_ID_PREFIX = 'mem_';
/** Keeps createdAt + ttlMs inside the ECMAScript time range. */
const MAX_TTL_MS = 8_640_000_000_000_000;

/**
 * Record ids reach the filesystem as `<id>.memory.json`, so an id containing
 * `/`, `\` or `..` would let a caller read or unlink files outside the store.
 * Ids are server-generated, so the pattern can be strict: anything that fails
 * it cannot name a record this store ever wrote.
 */
const RECORD_ID_PATTERN = /^mem_[A-Za-z0-9-]{1,64}$/;

const RUNTIME_MEMORY_KINDS: readonly RuntimeMemoryKind[] = ['fact', 'preference', 'hypothesis'];
const MEMORY_SOURCES: readonly MemorySource[] = ['user_stated', 'deterministic_rule', 'model_inferred'];
const MEMORY_LANGUAGES: readonly MemoryLanguage[] = ['ar', 'he', 'en', 'mixed'];
const MEMORY_STATUSES: readonly MemoryStatus[] = ['active', 'superseded', 'revoked', 'expired'];
const EXPORT_POLICIES: readonly ExportPolicy[] = ['personal_never_export', 'shareable_aggregate'];

function fail(message: string): never {
  throw new Error(`runtime memory: ${message}`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (!isIsoTimestamp(value)) fail(`${label} must be an ISO timestamp`);
}

/**
 * Validates the caller-supplied half of a record. Rejecting rather than
 * coercing matters for provenance: a silently clamped confidence or a
 * normalized scopeId would misreport what the caller actually asserted.
 */
function assertValidInput(input: CreateMemoryInput): void {
  if (!input || typeof input !== 'object') fail('input must be an object');
  if (!isNonEmptyString(input.scopeId)) fail('scopeId must be a non-empty string');
  if (!isNonEmptyString(input.content)) fail('content must be a non-empty string');
  if (!RUNTIME_MEMORY_KINDS.includes(input.kind)) {
    fail(`kind must be one of ${RUNTIME_MEMORY_KINDS.join(', ')}`);
  }
  if (!MEMORY_LANGUAGES.includes(input.language)) {
    fail(`language must be one of ${MEMORY_LANGUAGES.join(', ')}`);
  }
  if (!MEMORY_SOURCES.includes(input.source)) {
    fail(`source must be one of ${MEMORY_SOURCES.join(', ')}`);
  }
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)
    || input.confidence < 0 || input.confidence > 1) {
    fail('confidence must be a finite number in 0..1');
  }
  assertTimestamp(input.observedAt, 'observedAt');
  if (input.exportPolicy !== undefined && !EXPORT_POLICIES.includes(input.exportPolicy)) {
    fail(`exportPolicy must be one of ${EXPORT_POLICIES.join(', ')}`);
  }
  if (input.ttlMs !== undefined
    && (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0 || input.ttlMs > MAX_TTL_MS)) {
    // Upper bound included so staleAfter stays a representable date: without it
    // buildRecord throws a bare RangeError, escaping this module's own
    // "runtime memory: ..." error contract.
    fail(`ttlMs must be a positive number of milliseconds no greater than ${MAX_TTL_MS}`);
  }
  if (input.evidenceIds !== undefined
    && (!Array.isArray(input.evidenceIds) || !input.evidenceIds.every((id) => isNonEmptyString(id)))) {
    fail('evidenceIds must be an array of non-empty strings');
  }
}

/** Frozen records make the readonly contract enforceable at runtime, not only in types. */
function freezeRecord(record: RuntimeMemoryRecord): RuntimeMemoryRecord {
  Object.freeze(record.evidenceIds);
  return Object.freeze(record);
}

/**
 * Builds a record from the caller's fields only. Every server-assigned field is
 * written explicitly here, and the input is never spread, so extra properties
 * on the input object (a forged `id`, `status`, `staleAfter`, or supersession
 * link) have nowhere to land.
 */
function buildRecord(
  input: CreateMemoryInput,
  now: string,
  defaultTtlMs: number,
  supersedesId?: string,
): RuntimeMemoryRecord {
  const ttlMs = input.ttlMs ?? defaultTtlMs;
  const record: RuntimeMemoryRecord = {
    version: MEMORY_RECORD_SCHEMA_VERSION,
    id: `${RECORD_ID_PREFIX}${randomUUID()}`,
    scopeId: input.scopeId,
    kind: input.kind,
    content: input.content,
    language: input.language,
    source: input.source,
    confidence: input.confidence,
    exportPolicy: input.exportPolicy ?? 'personal_never_export',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    observedAt: input.observedAt,
    // Measured from write time, not observedAt: a fact observed long ago but
    // recorded today is newly known, and should not be born stale.
    staleAfter: new Date(Date.parse(now) + ttlMs).toISOString(),
    ...(supersedesId ? { supersedesId } : {}),
    evidenceIds: [...(input.evidenceIds ?? [])],
  };
  return freezeRecord(record);
}

/** Produces the next status of an existing record without mutating the stored one. */
function withStatus(
  record: RuntimeMemoryRecord,
  patch: Partial<Pick<RuntimeMemoryRecord, 'status' | 'updatedAt' | 'revokedAt' | 'supersededById'>>,
): RuntimeMemoryRecord {
  return freezeRecord({ ...record, ...patch, evidenceIds: [...record.evidenceIds] });
}

/**
 * Shape guard for anything read back from disk. A half-written or hand-edited
 * file must be skipped rather than surface as a partial record, so this checks
 * the schema version and every field retrieval filters on.
 */
function isRuntimeMemoryRecord(value: unknown): value is RuntimeMemoryRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === MEMORY_RECORD_SCHEMA_VERSION
    && typeof raw.id === 'string' && RECORD_ID_PATTERN.test(raw.id)
    && isNonEmptyString(raw.scopeId)
    && RUNTIME_MEMORY_KINDS.includes(raw.kind as RuntimeMemoryKind)
    && typeof raw.content === 'string'
    && MEMORY_LANGUAGES.includes(raw.language as MemoryLanguage)
    && MEMORY_SOURCES.includes(raw.source as MemorySource)
    && typeof raw.confidence === 'number'
    && EXPORT_POLICIES.includes(raw.exportPolicy as ExportPolicy)
    && MEMORY_STATUSES.includes(raw.status as MemoryStatus)
    && isIsoTimestamp(raw.createdAt)
    && isIsoTimestamp(raw.updatedAt)
    && isIsoTimestamp(raw.observedAt)
    && isIsoTimestamp(raw.staleAfter)
    && Array.isArray(raw.evidenceIds);
}

/** Returns the id only if it can name a record this store wrote; otherwise null. */
function toSafeId(id: unknown): string | null {
  return typeof id === 'string' && RECORD_ID_PATTERN.test(id) ? id : null;
}

function isFresh(record: RuntimeMemoryRecord, now: string): boolean {
  return Date.parse(record.staleAfter) > Date.parse(now);
}

/**
 * Code-unit ordering, never localeCompare: ordering feeds retrieval results and
 * must not shift with the host's locale.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Timestamps are compared as instants, not as text. ISO timestamps carrying
 * different UTC offsets sort differently as strings than they do in time, and
 * isIsoTimestamp accepts offsets, so a textual sort can rank an older record
 * above a newer one — which `limit` would then return in place of the newest.
 */
function compareInstants(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return compareStrings(left, right);
  return leftMs - rightMs;
}

/** Newest observation first; createdAt then id break ties so ordering is total. */
function byNewestObserved(a: RuntimeMemoryRecord, b: RuntimeMemoryRecord): number {
  return compareInstants(b.observedAt, a.observedAt)
    || compareInstants(b.createdAt, a.createdAt)
    || compareStrings(a.id, b.id);
}

/** Oldest first for inspection, so a supersession chain reads in write order. */
function byOldestCreated(a: RuntimeMemoryRecord, b: RuntimeMemoryRecord): number {
  return compareInstants(a.createdAt, b.createdAt) || compareStrings(a.id, b.id);
}

/**
 * Persistence seam. Everything privacy-relevant lives in createStore() above
 * this, so a file-backed and an in-memory store cannot diverge in behaviour.
 */
interface RecordRepository {
  readOne(id: string): RuntimeMemoryRecord | null;
  readAll(): RuntimeMemoryRecord[];
  write(record: RuntimeMemoryRecord): void;
  remove(id: string): boolean;
  /**
   * Removes every stored artifact attributable to the scope, including any the
   * reader is unable to parse as a record. Deletion is the one operation that
   * must reach further than retrieval does: a file too damaged to read still
   * holds the user's content, so leaving it behind would make "delete my data"
   * untrue. Only the backend knows what it is holding, so it does the sweep.
   */
  removeScope(scopeId: string): number;
}

function createStore(repository: RecordRepository, defaultTtlMs: number): RuntimeMemoryStore {
  function readSafe(id: unknown): RuntimeMemoryRecord | null {
    const safeId = toSafeId(id);
    return safeId === null ? null : repository.readOne(safeId);
  }

  function listScope(scopeId: string): readonly RuntimeMemoryRecord[] {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    return Object.freeze(
      repository.readAll().filter((record) => record.scopeId === scopeId).sort(byOldestCreated),
    );
  }

  return {
    put(input: CreateMemoryInput, now: string): RuntimeMemoryRecord {
      assertTimestamp(now, 'now');
      assertValidInput(input);
      const record = buildRecord(input, now, defaultTtlMs);
      repository.write(record);
      return record;
    },

    get(id: string): RuntimeMemoryRecord | null {
      return readSafe(id);
    },

    retrieve(query: MemoryQuery): readonly RuntimeMemoryRecord[] {
      if (!query || typeof query !== 'object') fail('query must be an object');
      if (!isNonEmptyString(query.scopeId)) fail('query.scopeId must be a non-empty string');
      assertTimestamp(query.now, 'query.now');
      if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
        fail('query.limit must be a positive integer');
      }

      const matches = repository.readAll().filter((record) => {
        // The two filters the contract makes unconditional: anything revoked,
        // superseded, expired, or past its staleAfter is structurally unable to
        // reach a consumer, whatever the rest of the query asks for.
        if (record.status !== 'active') return false;
        if (!isFresh(record, query.now)) return false;
        if (record.scopeId !== query.scopeId) return false;
        if (query.kind !== undefined && record.kind !== query.kind) return false;
        if (query.language !== undefined && record.language !== query.language) return false;
        if (query.minConfidence !== undefined && record.confidence < query.minConfidence) return false;
        return true;
      }).sort(byNewestObserved);

      return Object.freeze(query.limit === undefined ? matches : matches.slice(0, query.limit));
    },

    listAll(scopeId: string): readonly RuntimeMemoryRecord[] {
      return listScope(scopeId);
    },

    supersede(oldId: string, input: CreateMemoryInput, now: string): RuntimeMemoryRecord {
      assertTimestamp(now, 'now');
      const prior = readSafe(oldId);
      if (!prior) fail(`supersede target ${String(oldId)} not found`);
      if (prior.supersededById) {
        fail(`${prior.id} is already superseded by ${prior.supersededById}; supersede the head of the chain`);
      }
      if (prior.status === 'revoked') {
        fail(`${prior.id} is revoked; superseding it would undo a deliberate revocation`);
      }
      assertValidInput(input);
      if (input.scopeId !== prior.scopeId) {
        fail(`supersede must stay in one scope (${prior.scopeId} received ${input.scopeId})`);
      }

      const replacement = buildRecord(input, now, defaultTtlMs, prior.id);
      // Replacement first: a crash between the two writes leaves both records
      // visible, which is recoverable. The reverse order could hide the prior
      // record with no replacement written, losing the memory outright.
      repository.write(replacement);
      repository.write(withStatus(prior, {
        status: 'superseded',
        supersededById: replacement.id,
        updatedAt: now,
      }));
      return replacement;
    },

    revoke(id: string, at: string): boolean {
      assertTimestamp(at, 'at');
      const record = readSafe(id);
      if (!record) return false;
      // Idempotent, and the first revocation timestamp is the auditable one.
      if (record.status === 'revoked') return true;
      repository.write(withStatus(record, { status: 'revoked', revokedAt: at, updatedAt: at }));
      return true;
    },

    deleteById(id: string): boolean {
      const safeId = toSafeId(id);
      return safeId === null ? false : repository.remove(safeId);
    },

    deleteScope(scopeId: string): number {
      if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
      return repository.removeScope(scopeId);
    },

    export(scopeId: string, now: string): MemoryExport {
      assertTimestamp(now, 'now');
      // Deliberately includes personal records: this is the user's own data,
      // and a separate path from fine-tuning export (see exportPolicy.ts).
      return Object.freeze({
        version: MEMORY_RECORD_SCHEMA_VERSION,
        scopeId,
        exportedAt: now,
        records: listScope(scopeId),
      });
    },

    prune(now: string): number {
      assertTimestamp(now, 'now');
      let expired = 0;
      for (const record of repository.readAll()) {
        // Only active records expire. A superseded or revoked record keeps its
        // status because that status is the audit trail; staleness must not
        // overwrite the reason a record left retrieval.
        if (record.status !== 'active' || isFresh(record, now)) continue;
        repository.write(withStatus(record, { status: 'expired', updatedAt: now }));
        expired++;
      }
      return expired;
    },
  };
}

/** Default record directory, honouring MAYBESITTER_DATA_DIR like sibling stores. */
function defaultDataDir(): string {
  const root = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
  return path.join(root, MEMORY_SUBDIR);
}

function createFileRepository(resolveDataDir: () => string): RecordRepository {
  function ensureDir(): string {
    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  function recordPath(dataDir: string, id: string): string {
    return path.join(dataDir, `${id}${MEMORY_FILE_EXT}`);
  }

  function readFile(filePath: string): RuntimeMemoryRecord | null {
    try {
      const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
      if (isRuntimeMemoryRecord(raw)) return freezeRecord(raw);
    } catch {
      // Corrupt, truncated, or written by another schema version — skip it
      // rather than failing the whole read, so one bad file cannot deny the
      // user access to the rest of their memory.
    }
    return null;
  }

  /**
   * Lenient scope attribution for deletion only. Enough of a file may survive
   * to say whose it is even when it fails the full record guard, and that is
   * exactly the file a scope deletion must not miss.
   */
  function readScopeId(filePath: string): string | null {
    let text: string;
    try {
      text = readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }

    try {
      const raw = JSON.parse(text) as Record<string, unknown> | null;
      if (typeof raw?.scopeId === 'string') return raw.scopeId;
    } catch {
      // Fall through: the most likely corruption is a write truncated by a
      // crash, and scopeId is written near the top of the record, so the name
      // of the owner usually survives even when the JSON does not.
    }

    const match = /"scopeId"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
  }

  return {
    readOne(id: string): RuntimeMemoryRecord | null {
      const filePath = recordPath(ensureDir(), id);
      return existsSync(filePath) ? readFile(filePath) : null;
    },

    readAll(): RuntimeMemoryRecord[] {
      const dataDir = ensureDir();
      const records: RuntimeMemoryRecord[] = [];
      for (const entry of readdirSync(dataDir)) {
        if (!entry.endsWith(MEMORY_FILE_EXT)) continue;
        const record = readFile(path.join(dataDir, entry));
        if (record) records.push(record);
      }
      return records;
    },

    write(record: RuntimeMemoryRecord): void {
      const filePath = recordPath(ensureDir(), record.id);
      // Temp-then-rename so a reader never observes a half-written record;
      // 0600 because every record is personal by default.
      const temporary = `${filePath}.${process.pid}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, filePath);
    },

    remove(id: string): boolean {
      const dataDir = ensureDir();
      const filePath = recordPath(dataDir, id);
      const existed = existsSync(filePath);
      if (existed) unlinkSync(filePath);

      // Sweep any temp file a crashed write left for this same id. Nothing else
      // can reach it afterwards — readAll() skips .tmp, so prune() and revoke()
      // never see it — and it holds the complete record, content included.
      const tempPrefix = `${id}${MEMORY_FILE_EXT}`;
      for (const entry of readdirSync(dataDir)) {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(TEMP_FILE_EXT)) continue;
        unlinkSync(path.join(dataDir, entry));
      }
      return existed;
    },

    removeScope(scopeId: string): number {
      const dataDir = ensureDir();
      let removed = 0;
      for (const entry of readdirSync(dataDir)) {
        // Orphaned temp files (`<id>.memory.json.<pid>.tmp`, left by a crash
        // between write and rename) hold a complete record with full content.
        // Skipping them would leave the user's data on disk after they asked
        // for it to be deleted.
        if (!entry.endsWith(MEMORY_FILE_EXT) && !entry.endsWith(TEMP_FILE_EXT)) continue;
        const filePath = path.join(dataDir, entry);
        // Attribution is by scopeId alone, and only an exact match deletes. A
        // file too damaged to name any owner is left in place: deleting
        // unattributable files on any scope deletion could destroy a different
        // user's data. That residue is an operator problem, not something one
        // user's deletion may resolve on their behalf.
        if (readScopeId(filePath) !== scopeId) continue;
        unlinkSync(filePath);
        removed++;
      }
      return removed;
    },
  };
}

function createMemoryRepository(): RecordRepository {
  const records = new Map<string, RuntimeMemoryRecord>();
  return {
    readOne: (id) => records.get(id) ?? null,
    readAll: () => Array.from(records.values()),
    write: (record) => {
      records.set(record.id, record);
    },
    remove: (id) => records.delete(id),
    removeScope: (scopeId) => {
      let removed = 0;
      for (const [id, record] of Array.from(records.entries())) {
        if (record.scopeId === scopeId && records.delete(id)) removed++;
      }
      return removed;
    },
  };
}

function resolveTtl(options?: RuntimeMemoryStoreOptions): number {
  const ttlMs = options?.defaultTtlMs ?? DEFAULT_MEMORY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail('defaultTtlMs must be a positive number of milliseconds');
  return ttlMs;
}

/**
 * File-backed store, one JSON file per record under
 * `<MAYBESITTER_DATA_DIR|cwd/.maybesitter>/runtime-memory/<id>.memory.json`.
 * `options.dataDir` overrides that leaf directory outright, as in the alpha
 * stores. The directory is resolved per call, so a test may set the env var
 * after constructing the store.
 */
export function createFileRuntimeMemoryStore(options?: RuntimeMemoryStoreOptions): RuntimeMemoryStore {
  return createStore(createFileRepository(() => options?.dataDir ?? defaultDataDir()), resolveTtl(options));
}

/** In-memory store with identical semantics, for tests and ephemeral use. */
export function createInMemoryRuntimeMemoryStore(options?: RuntimeMemoryStoreOptions): RuntimeMemoryStore {
  return createStore(createMemoryRepository(), resolveTtl(options));
}

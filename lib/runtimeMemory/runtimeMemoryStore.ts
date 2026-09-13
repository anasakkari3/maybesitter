/**
 * Runtime memory, in the user's own tree (UC-1.0c, #142).
 *
 * Owns the three memory kinds that src/domain/memory declares but leaves
 * disabled (`fact`, `preference`, `hypothesis`). Lives under lib/runtimeMemory
 * rather than lib/memory to stay visibly distinct from the canonical
 * commitment/observation stores, which this module never touches.
 *
 * ── What the move fixes ──────────────────────────────────────────
 *
 * One JSON file per record under `MAYBESITTER_DATA_DIR/runtime-memory`. This
 * is the store the product's whole premise rests on — what MaybeSitter
 * remembers about you — and it was on a per-instance disk: a redeploy erased
 * it and a second instance never saw it. Records now live at
 * `users/{uid}/memory/{memoryId}` and are deleted with the account.
 *
 * ── Three privacy properties, each with its own mechanism ────────
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
 * which adapter they hold. The sibling alpha stores duplicated their logic per
 * backend, which is how their in-memory prune() drifted into a no-op; privacy
 * behaviour must not be able to drift between a test store and a production one.
 *
 * ── Why some reads are collection-group queries ──────────────────
 *
 * `get`, `revoke` and `deleteById` are addressed by record id alone — the API
 * predates there being a user tree to put the record in — so they resolve
 * through a group query on the `id` field rather than by asking the caller for
 * a scope they do not have. `firestore.indexes.json` carries the index.
 *
 * No function here reads the system clock. Every timestamp is supplied by the
 * caller (`now`/`at`), so store behaviour is reproducible in tests and replays.
 */
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_MEMORY_TTL_MS,
  MEMORY_ORIGINS,
  MEMORY_RECORD_SCHEMA_VERSION,
  type CreateMemoryInput,
  type ExportPolicy,
  type MemoryExport,
  type MemoryLanguage,
  type MemoryQuery,
  type MemorySource,
  type MemoryProvenance,
  type MemoryStatus,
  type RuntimeMemoryKind,
  type RuntimeMemoryRecord,
  type RuntimeMemoryStore,
  type RuntimeMemoryStoreOptions,
} from '../../src/contracts/v1/memoryContracts';
import { isIsoTimestamp, isNonEmptyString } from '../evaluation/registry/validationPrimitives';
import {
  MEMORY,
  createMemoryStorage,
  getStorage,
  requireDocId,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

const RECORD_ID_PREFIX = 'mem_';
/** Keeps createdAt + ttlMs inside the ECMAScript time range. */
const MAX_TTL_MS = 8_640_000_000_000_000;

/**
 * Record ids are server-generated, so the pattern can be strict: anything that
 * fails it cannot name a record this store ever wrote. It is also the document
 * id, so it has to stay a legal path segment.
 */
const RECORD_ID_PATTERN = /^mem_[A-Za-z0-9-]{1,64}$/;

const RUNTIME_MEMORY_KINDS: readonly RuntimeMemoryKind[] = ['fact', 'preference', 'hypothesis', 'goal'];
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
  if (input.provenance !== undefined) assertValidProvenance(input.provenance, input.source);
}

/**
 * Provenance is validated as strictly as the rest of the record, and against
 * the record's own `source`, because it is what the user is shown as the reason
 * to trust a fact. A record that claims `user_stated` while naming the model
 * that produced it is not a labelling slip — it is the screen telling somebody
 * they said something they did not.
 */
function assertValidProvenance(provenance: MemoryProvenance, source: CreateMemoryInput['source']): void {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    fail('provenance must be an object');
  }
  if (!MEMORY_ORIGINS.includes(provenance.origin)) {
    fail(`provenance.origin must be one of ${MEMORY_ORIGINS.join(', ')}`);
  }
  for (const field of ['originRef', 'model', 'promptVersion'] as const) {
    const value = provenance[field];
    if (value !== undefined && !isNonEmptyString(value)) fail(`provenance.${field} must be a non-empty string`);
  }
  if (provenance.confirmedByUserAt !== undefined) {
    assertTimestamp(provenance.confirmedByUserAt, 'provenance.confirmedByUserAt');
  }
  if (source !== 'model_inferred' && provenance.model !== undefined) {
    fail(`provenance.model is set on a ${source} record, which no model produced`);
  }
  // The one asymmetry worth spelling out: a model-inferred record may exist
  // unconfirmed *inside* an extraction proposal, but nothing writes one to the
  // store without the user having agreed to it (UC-2.7b, #168). Enforced here
  // so the rule survives a future caller that forgets it.
  if (source === 'model_inferred' && provenance.confirmedByUserAt === undefined) {
    fail('a model_inferred record must carry provenance.confirmedByUserAt');
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
    ...(input.provenance ? { provenance: Object.freeze({ ...input.provenance }) } : {}),
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
 * Shape guard for anything read back. A half-written or hand-edited document
 * must be skipped rather than surface as a partial record, so this checks the
 * schema version and every field retrieval filters on.
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

function collectionFor(scopeId: string): string {
  return userCol(userIdForKey(scopeId), MEMORY);
}

function recordPath(scopeId: string, id: string): string {
  return `${collectionFor(scopeId)}/${requireDocId(id)}`;
}

function resolveTtl(options?: RuntimeMemoryStoreOptions): number {
  const ttlMs = options?.defaultTtlMs ?? DEFAULT_MEMORY_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) fail('defaultTtlMs must be a positive number of milliseconds');
  return ttlMs;
}

export class StorageRuntimeMemoryStore implements RuntimeMemoryStore {
  private readonly defaultTtlMs: number;

  constructor(private readonly injected?: StorageAdapter, options?: RuntimeMemoryStoreOptions) {
    this.defaultTtlMs = resolveTtl(options);
  }

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  /** Every record in one scope, shape-checked. */
  private async inScope(scopeId: string): Promise<RuntimeMemoryRecord[]> {
    const rows = await this.storage.list<RuntimeMemoryRecord>(collectionFor(scopeId));
    return rows.filter((row) => isRuntimeMemoryRecord(row.data)).map((row) => freezeRecord(row.data));
  }

  /** Every record anywhere, with its path. Used by prune and by id lookups. */
  private async everywhere(): Promise<Array<{ path: string; record: RuntimeMemoryRecord }>> {
    const rows = await this.storage.listGroup<RuntimeMemoryRecord>(MEMORY);
    return rows
      .filter((row) => isRuntimeMemoryRecord(row.data))
      .map((row) => ({ path: row.path, record: freezeRecord(row.data) }));
  }

  /** A record addressed by id alone; see the header on why this is a group read. */
  private async findById(id: string): Promise<{ path: string; record: RuntimeMemoryRecord } | null> {
    const safeId = toSafeId(id);
    if (safeId === null) return null;
    const rows = await this.storage.listGroup<RuntimeMemoryRecord>(MEMORY, {
      where: [['id', '==', safeId]],
      limit: 1,
    });
    const row = rows[0];
    return row && isRuntimeMemoryRecord(row.data) ? { path: row.path, record: freezeRecord(row.data) } : null;
  }

  async put(input: CreateMemoryInput, now: string): Promise<RuntimeMemoryRecord> {
    assertTimestamp(now, 'now');
    assertValidInput(input);
    const record = buildRecord(input, now, this.defaultTtlMs);
    await this.storage.set<RuntimeMemoryRecord>(recordPath(record.scopeId, record.id), record);
    return record;
  }

  async get(id: string): Promise<RuntimeMemoryRecord | null> {
    return (await this.findById(id))?.record ?? null;
  }

  async retrieve(query: MemoryQuery): Promise<readonly RuntimeMemoryRecord[]> {
    if (!query || typeof query !== 'object') fail('query must be an object');
    if (!isNonEmptyString(query.scopeId)) fail('query.scopeId must be a non-empty string');
    assertTimestamp(query.now, 'query.now');
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
      fail('query.limit must be a positive integer');
    }

    const matches = (await this.inScope(query.scopeId)).filter((record) => {
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
  }

  async listAll(scopeId: string): Promise<readonly RuntimeMemoryRecord[]> {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    return Object.freeze(
      (await this.inScope(scopeId)).filter((record) => record.scopeId === scopeId).sort(byOldestCreated),
    );
  }

  async supersede(oldId: string, input: CreateMemoryInput, now: string): Promise<RuntimeMemoryRecord> {
    assertTimestamp(now, 'now');
    const held = await this.findById(oldId);
    if (!held) fail(`supersede target ${String(oldId)} not found`);
    const prior = held.record;
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

    const replacement = buildRecord(input, now, this.defaultTtlMs, prior.id);
    // Replacement first: a crash between the two writes leaves both records
    // visible, which is recoverable. The reverse order could hide the prior
    // record with no replacement written, losing the memory outright.
    await this.storage.set<RuntimeMemoryRecord>(recordPath(replacement.scopeId, replacement.id), replacement);
    await this.storage.set<RuntimeMemoryRecord>(held.path, withStatus(prior, {
      status: 'superseded',
      supersededById: replacement.id,
      updatedAt: now,
    }));
    return replacement;
  }

  async revoke(id: string, at: string): Promise<boolean> {
    assertTimestamp(at, 'at');
    const held = await this.findById(id);
    if (!held) return false;
    // Idempotent, and the first revocation timestamp is the auditable one.
    if (held.record.status === 'revoked') return true;
    await this.storage.set<RuntimeMemoryRecord>(
      held.path,
      withStatus(held.record, { status: 'revoked', revokedAt: at, updatedAt: at }),
    );
    return true;
  }

  async deleteById(id: string): Promise<boolean> {
    const held = await this.findById(id);
    if (!held) return false;
    await this.storage.delete(held.path);
    return true;
  }

  async deleteScope(scopeId: string): Promise<number> {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    const collection = collectionFor(scopeId);
    const rows = await this.storage.list<RuntimeMemoryRecord>(collection);
    // Everything under the scope's collection goes, including a document too
    // damaged to parse as a record: it still holds the user's content, and
    // leaving it would make "delete my data" untrue.
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
    return rows.filter((row) => isRuntimeMemoryRecord(row.data)).length;
  }

  async export(scopeId: string, now: string): Promise<MemoryExport> {
    assertTimestamp(now, 'now');
    // Deliberately includes personal records: this is the user's own data,
    // and a separate path from fine-tuning export (see exportPolicy.ts).
    return Object.freeze({
      version: MEMORY_RECORD_SCHEMA_VERSION,
      scopeId,
      exportedAt: now,
      records: await this.listAll(scopeId),
    });
  }

  async prune(now: string): Promise<number> {
    assertTimestamp(now, 'now');
    let expired = 0;
    for (const { path, record } of await this.everywhere()) {
      // Only active records expire. A superseded or revoked record keeps its
      // status because that status is the audit trail; staleness must not
      // overwrite the reason a record left retrieval.
      if (record.status !== 'active' || isFresh(record, now)) continue;
      await this.storage.set<RuntimeMemoryRecord>(path, withStatus(record, { status: 'expired', updatedAt: now }));
      expired += 1;
    }
    return expired;
  }
}

export function createStorageRuntimeMemoryStore(
  options?: RuntimeMemoryStoreOptions,
  storage?: StorageAdapter,
): RuntimeMemoryStore {
  return new StorageRuntimeMemoryStore(storage, options);
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export function createInMemoryRuntimeMemoryStore(options?: RuntimeMemoryStoreOptions): RuntimeMemoryStore {
  return new StorageRuntimeMemoryStore(createMemoryStorage(), options);
}

/**
 * Append-only behavioural feedback event store (Sprint 03, issue #13).
 *
 * Holds what the user did with what we proposed. Three properties are
 * structural here rather than conventional, because each of them is a way the
 * log could misrepresent the user:
 *
 *  1. One behaviour is one record. The idempotency key is a digest of
 *     scopeId + subjectId + outcome + occurredAt, and the record id is that
 *     same digest, so a resubmitted outcome cannot occupy a second slot even
 *     if two writers race: they address the same path. append() reads before
 *     writing and returns the stored event untouched, so a retry never moves
 *     recordedAt either. A double-counted outcome is a false claim about how
 *     often the user behaved that way.
 *
 *  2. Nothing is rewritten. revoke() adds revokedAt and copies every other
 *     field forward unchanged; a second revoke is refused rather than
 *     re-stamped, because revokedAt records when the *user* made the
 *     correction and overwriting it would misdate their objection. A reversal
 *     of behaviour is not a revocation — it is a new `undo` event, appended by
 *     the caller.
 *
 *  3. This module observes, it never writes canonical state. It imports no
 *     command handler, no state gateway, no persistence outside its own
 *     directory, and not the legacy counter service — a feedback event must
 *     never be able to edit the commitment it describes.
 *     tests/feedback/feedbackBoundaries.test.ts enforces that over the whole
 *     transitive import closure.
 *
 * Both backends share createStore() and differ only in persistence, following
 * lib/runtimeMemory/runtimeMemoryStore.ts: the sibling alpha stores duplicated
 * their logic per backend, which is how one of them drifted into a no-op.
 *
 * No function here reads the system clock or any source of randomness. Every
 * timestamp is a parameter and every id is derived, so an append is fully
 * reproducible — which is what makes the idempotency above verifiable rather
 * than merely likely.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackActor,
  type FeedbackBaseline,
  type FeedbackEvent,
  type FeedbackEventQuery,
  type FeedbackEventStore,
  type FeedbackEventStoreOptions,
  type FeedbackOutcome,
  type FeedbackSource,
  type LegacyCounterName,
} from '../../src/contracts/v1/feedbackContracts';
import { isIsoTimestamp, isNonEmptyString } from '../evaluation/registry/validationPrimitives';

const FEEDBACK_SUBDIR = 'feedback-events';
const EVENT_FILE_EXT = '.feedback.json';
const BASELINE_FILE_EXT = '.feedback-baseline.json';
/** Suffix of a temp file written before the atomic rename. */
const TEMP_FILE_EXT = '.tmp';
const EVENT_ID_PREFIX = 'fbk_';
const BASELINE_ID_PREFIX = 'bsl_';

/**
 * Ids reach the filesystem as `<id>.feedback.json`, so an id containing `/`,
 * `\` or `..` would let a caller read or unlink files outside the store. Ids
 * are derived digests, never caller text, so the pattern can be exact:
 * anything failing it cannot name a record this store ever wrote.
 */
const EVENT_ID_PATTERN = /^fbk_[0-9a-f]{64}$/;

export const FEEDBACK_OUTCOMES: readonly FeedbackOutcome[] = [
  'accept', 'edit', 'reject', 'defer', 'complete', 'ignore', 'undo',
];
export const FEEDBACK_ACTORS: readonly FeedbackActor[] = ['user', 'system'];
/**
 * `migration_baseline` is deliberately absent. It marks history inherited from
 * the counter store, which by definition has no per-event timestamps; letting a
 * caller append one would manufacture an event that never happened.
 */
const APPENDABLE_SOURCES: readonly FeedbackSource[] = ['mobile_action', 'scheduler'];
const LEGACY_COUNTER_NAMES: readonly LegacyCounterName[] = [
  'ignoredSuggestions', 'completedActions', 'delayedActions', 'clarificationSuccesses', 'clarificationFailures',
];

function fail(message: string): never {
  throw new Error(`feedback events: ${message}`);
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (!isIsoTimestamp(value)) fail(`${label} must be an ISO timestamp`);
}

/**
 * Validates the caller-supplied half of an event. Rejecting rather than
 * coercing matters for provenance: a defaulted actor or a normalized scopeId
 * would record a behaviour nobody reported.
 */
function assertValidInput(input: AppendFeedbackEventInput): void {
  if (!input || typeof input !== 'object') fail('input must be an object');
  if (!isNonEmptyString(input.scopeId)) fail('scopeId must be a non-empty string');
  if (!isNonEmptyString(input.subjectId)) fail('subjectId must be a non-empty string');
  if (!FEEDBACK_OUTCOMES.includes(input.outcome)) {
    fail(`outcome must be one of ${FEEDBACK_OUTCOMES.join(', ')}`);
  }
  if (!FEEDBACK_ACTORS.includes(input.actor)) {
    fail(`actor must be one of ${FEEDBACK_ACTORS.join(', ')}`);
  }
  if (!APPENDABLE_SOURCES.includes(input.source)) {
    fail(`source must be one of ${APPENDABLE_SOURCES.join(', ')}`);
  }
  assertTimestamp(input.occurredAt, 'occurredAt');
}

/**
 * The identity of one behaviour.
 *
 * JSON-encoded before hashing so the four parts cannot be confused by their own
 * content: a subjectId containing the separator would otherwise let one
 * behaviour impersonate another. `actor` and `source` are deliberately excluded
 * — the same outcome reported by the app and by the scheduler is still one
 * outcome, and including them would let a retry through a different path count
 * twice.
 */
function idempotencyKeyOf(input: AppendFeedbackEventInput): string {
  const canonical = JSON.stringify([input.scopeId, input.subjectId, input.outcome, input.occurredAt]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Scope ids are caller text, so they are hashed rather than used as filenames. */
function baselineFileId(scopeId: string): string {
  return `${BASELINE_ID_PREFIX}${createHash('sha256').update(scopeId, 'utf8').digest('hex')}`;
}

/** Frozen records make the readonly contract enforceable at runtime, not only in types. */
function freezeEvent(event: FeedbackEvent): FeedbackEvent {
  return Object.freeze(event);
}

function freezeBaseline(baseline: FeedbackBaseline): FeedbackBaseline {
  Object.freeze(baseline.counters);
  return Object.freeze(baseline);
}

/**
 * Builds an event from the caller's fields only. Every server-assigned field is
 * written explicitly and the input is never spread, so a forged `id`,
 * `recordedAt`, `idempotencyKey` or `revokedAt` on the input object has nowhere
 * to land. `revokedAt` is omitted rather than set to undefined: an unrevoked
 * event should not carry the property at all.
 */
function buildEvent(input: AppendFeedbackEventInput, recordedAt: string): FeedbackEvent {
  const idempotencyKey = idempotencyKeyOf(input);
  return freezeEvent({
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    id: `${EVENT_ID_PREFIX}${idempotencyKey}`,
    scopeId: input.scopeId,
    outcome: input.outcome,
    subjectId: input.subjectId,
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    recordedAt,
    idempotencyKey,
  });
}

/**
 * Copies a stored event forward with its revocation stamped. Written field by
 * field rather than spread so that nothing a hand-edited file smuggled in
 * survives a revocation, and so the append-only guarantee is visible here: this
 * is the only place a stored event is ever rewritten, and it adds one field.
 */
function withRevocation(event: FeedbackEvent, at: string): FeedbackEvent {
  return freezeEvent({
    version: event.version,
    id: event.id,
    scopeId: event.scopeId,
    outcome: event.outcome,
    subjectId: event.subjectId,
    actor: event.actor,
    source: event.source,
    occurredAt: event.occurredAt,
    recordedAt: event.recordedAt,
    idempotencyKey: event.idempotencyKey,
    revokedAt: at,
  });
}

/**
 * Shape guard for anything read back from disk. A half-written or hand-edited
 * file must be skipped rather than surface as a partial event, so this checks
 * the schema version and every field a consumer filters or aggregates on.
 */
function isFeedbackEvent(value: unknown): value is FeedbackEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === FEEDBACK_EVENT_SCHEMA_VERSION
    && typeof raw.id === 'string' && EVENT_ID_PATTERN.test(raw.id)
    && isNonEmptyString(raw.scopeId)
    && isNonEmptyString(raw.subjectId)
    && FEEDBACK_OUTCOMES.includes(raw.outcome as FeedbackOutcome)
    && FEEDBACK_ACTORS.includes(raw.actor as FeedbackActor)
    && (APPENDABLE_SOURCES.includes(raw.source as FeedbackSource) || raw.source === 'migration_baseline')
    && isIsoTimestamp(raw.occurredAt)
    && isIsoTimestamp(raw.recordedAt)
    && typeof raw.idempotencyKey === 'string' && raw.idempotencyKey.length > 0
    && (raw.revokedAt === undefined || isIsoTimestamp(raw.revokedAt));
}

function isFeedbackBaseline(value: unknown): value is FeedbackBaseline {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return raw.version === FEEDBACK_EVENT_SCHEMA_VERSION
    && isNonEmptyString(raw.scopeId)
    && raw.timestampsUnavailable === true
    && isIsoTimestamp(raw.migratedAt)
    && (raw.lastUpdatedAt === null || isIsoTimestamp(raw.lastUpdatedAt))
    && hasLegacyCounters(raw.counters);
}

function hasLegacyCounters(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const counters = value as Record<string, unknown>;
  return LEGACY_COUNTER_NAMES.every((name) => {
    const count = counters[name];
    return typeof count === 'number' && Number.isInteger(count) && count >= 0;
  });
}

/**
 * Rebuilds a baseline from its own fields, dropping anything else the value
 * carried. The counters are copied name by name so an extra key on a caller's
 * object cannot enter the record and be mistaken for a sixth legacy counter.
 */
function buildBaseline(baseline: FeedbackBaseline): FeedbackBaseline {
  const counters = {} as Record<LegacyCounterName, number>;
  for (const name of LEGACY_COUNTER_NAMES) counters[name] = baseline.counters[name];
  return freezeBaseline({
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId: baseline.scopeId,
    counters,
    lastUpdatedAt: baseline.lastUpdatedAt,
    timestampsUnavailable: true,
    migratedAt: baseline.migratedAt,
  });
}

/** Returns the id only if it can name an event this store wrote; otherwise null. */
function toSafeId(id: unknown): string | null {
  return typeof id === 'string' && EVENT_ID_PATTERN.test(id) ? id : null;
}

/**
 * Code-unit ordering, never localeCompare: ordering feeds a history view and
 * must not shift with the host's locale.
 */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Timestamps are compared as instants, not as text. ISO timestamps carrying
 * different UTC offsets sort differently as strings than they do in time, so a
 * textual sort can rank an older event above a newer one — which `limit` would
 * then return in place of the newest.
 */
function compareInstants(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return compareStrings(left, right);
  return leftMs - rightMs;
}

/**
 * Oldest behaviour first. Keyed on occurredAt, never recordedAt, so a
 * late-arriving event reads where it belongs in the user's day rather than at
 * the end; recordedAt then id break ties so the ordering is total.
 */
function byOldestOccurred(a: FeedbackEvent, b: FeedbackEvent): number {
  return compareInstants(a.occurredAt, b.occurredAt)
    || compareInstants(a.recordedAt, b.recordedAt)
    || compareStrings(a.id, b.id);
}

/**
 * Persistence seam. Everything append-only or privacy-relevant lives in
 * createStore() above this, so a file-backed and an in-memory store cannot
 * diverge in behaviour.
 */
interface FeedbackRepository {
  readOne(id: string): FeedbackEvent | null;
  readAll(): FeedbackEvent[];
  write(event: FeedbackEvent): void;
  readBaseline(scopeId: string): FeedbackBaseline | null;
  writeBaseline(baseline: FeedbackBaseline): void;
  /**
   * Removes every stored artifact attributable to the scope — events, the
   * migration baseline, and anything the reader cannot parse — and returns the
   * number of *events* removed, which is what the contract's count means.
   * Deletion must reach further than retrieval does: a file too damaged to read
   * still holds the user's content, so leaving it behind would make "delete my
   * data" untrue. Only the backend knows what it is holding, so it does the sweep.
   */
  removeScope(scopeId: string): number;
}

function createStore(repository: FeedbackRepository): FeedbackEventStore {
  return {
    append(input: AppendFeedbackEventInput, recordedAt: string): FeedbackEvent {
      assertTimestamp(recordedAt, 'recordedAt');
      assertValidInput(input);

      const candidate = buildEvent(input, recordedAt);
      // Replay rather than re-apply, as in replayOrRecordParticipantDecision.
      // The stored event is returned untouched: its recordedAt is when we first
      // heard about the behaviour, and a retry is not new information.
      const existing = repository.readOne(candidate.id);
      if (existing) return existing;

      repository.write(candidate);
      return candidate;
    },

    get(id: string): FeedbackEvent | null {
      const safeId = toSafeId(id);
      return safeId === null ? null : repository.readOne(safeId);
    },

    list(query: FeedbackEventQuery): readonly FeedbackEvent[] {
      if (!query || typeof query !== 'object') fail('query must be an object');
      if (!isNonEmptyString(query.scopeId)) fail('query.scopeId must be a non-empty string');
      if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
        fail('query.limit must be a positive integer');
      }

      const matches = repository.readAll().filter((event) => {
        if (event.scopeId !== query.scopeId) return false;
        // Revoked events are included unless excluded explicitly: a history
        // that hid corrections would hide the evidence that one was applied.
        if (query.includeRevoked === false && event.revokedAt !== undefined) return false;
        return true;
      }).sort(byOldestOccurred);

      if (query.newestFirst) matches.reverse();
      return Object.freeze(query.limit === undefined ? matches : matches.slice(0, query.limit));
    },

    revoke(id: string, at: string): boolean {
      assertTimestamp(at, 'at');
      const safeId = toSafeId(id);
      const event = safeId === null ? null : repository.readOne(safeId);
      if (!event) return false;
      // Not an error, but not a second correction either: the first timestamp
      // is when the user objected, and re-stamping it would misdate them.
      if (event.revokedAt !== undefined) return false;
      repository.write(withRevocation(event, at));
      return true;
    },

    deleteScope(scopeId: string): number {
      if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
      return repository.removeScope(scopeId);
    },

    readBaseline(scopeId: string): FeedbackBaseline | null {
      if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
      return repository.readBaseline(scopeId);
    },

    /**
     * The raw persistence primitive: last write wins. The write-once rule the
     * design states lives in lib/feedback/baselineMigration.ts, which is the
     * only thing that should ever produce a baseline — re-deriving one after
     * dual-write has begun would fold outcomes already in the event log back
     * into the pre-log totals and count them twice.
     */
    writeBaseline(baseline: FeedbackBaseline): void {
      if (!isFeedbackBaseline(baseline)) {
        fail('baseline must carry the current version, a scopeId, five non-negative integer counters, '
          + 'migratedAt, and timestampsUnavailable: true');
      }
      repository.writeBaseline(buildBaseline(baseline));
    },
  };
}

/** Default record directory, honouring MAYBESITTER_DATA_DIR like sibling stores. */
function defaultDataDir(): string {
  const root = process.env.MAYBESITTER_DATA_DIR || path.join(process.cwd(), '.maybesitter');
  return path.join(root, FEEDBACK_SUBDIR);
}

function createFileRepository(resolveDataDir: () => string): FeedbackRepository {
  function ensureDir(): string {
    const dataDir = resolveDataDir();
    mkdirSync(dataDir, { recursive: true });
    return dataDir;
  }

  function filePath(dataDir: string, id: string, extension: string): string {
    return path.join(dataDir, `${id}${extension}`);
  }

  function readJson(file: string): unknown {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as unknown;
    } catch {
      // Corrupt, truncated, or written by another schema version — skip it
      // rather than failing the whole read, so one bad file cannot deny the
      // user access to the rest of their history.
      return null;
    }
  }

  /** Temp-then-rename so a reader never observes a half-written record; 0600 because it is personal. */
  function writeAtomic(file: string, value: unknown): void {
    const temporary = `${file}.${process.pid}${TEMP_FILE_EXT}`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, file);
  }

  /**
   * Lenient scope attribution for deletion only. Enough of a file may survive to
   * say whose it is even when it fails the full guard, and that is exactly the
   * file a scope deletion must not miss.
   */
  function readScopeId(file: string): string | null {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return null;
    }

    try {
      const raw = JSON.parse(text) as Record<string, unknown> | null;
      if (typeof raw?.scopeId === 'string') return raw.scopeId;
    } catch {
      // Fall through: the likeliest corruption is a write truncated by a crash,
      // and scopeId sits near the top of the record, so the name of the owner
      // usually survives even when the JSON does not.
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
    readOne(id: string): FeedbackEvent | null {
      const file = filePath(ensureDir(), id, EVENT_FILE_EXT);
      if (!existsSync(file)) return null;
      const raw = readJson(file);
      return isFeedbackEvent(raw) ? freezeEvent(raw) : null;
    },

    readAll(): FeedbackEvent[] {
      const dataDir = ensureDir();
      const events: FeedbackEvent[] = [];
      for (const entry of readdirSync(dataDir)) {
        if (!entry.endsWith(EVENT_FILE_EXT)) continue;
        const raw = readJson(path.join(dataDir, entry));
        if (isFeedbackEvent(raw)) events.push(freezeEvent(raw));
      }
      return events;
    },

    write(event: FeedbackEvent): void {
      writeAtomic(filePath(ensureDir(), event.id, EVENT_FILE_EXT), event);
    },

    readBaseline(scopeId: string): FeedbackBaseline | null {
      const file = filePath(ensureDir(), baselineFileId(scopeId), BASELINE_FILE_EXT);
      if (!existsSync(file)) return null;
      const raw = readJson(file);
      // The scopeId is re-checked rather than trusted from the filename, so a
      // hand-placed file cannot serve one user's counters to another.
      if (!isFeedbackBaseline(raw) || raw.scopeId !== scopeId) return null;
      return freezeBaseline(raw);
    },

    writeBaseline(baseline: FeedbackBaseline): void {
      writeAtomic(filePath(ensureDir(), baselineFileId(baseline.scopeId), BASELINE_FILE_EXT), baseline);
    },

    removeScope(scopeId: string): number {
      const dataDir = ensureDir();
      let removedEvents = 0;
      for (const entry of readdirSync(dataDir)) {
        // Orphaned temp files (`<id>.feedback.json.<pid>.tmp`, left by a crash
        // between write and rename) hold a complete record. Skipping them would
        // leave the user's data on disk after they asked for it to be deleted.
        const isKnownFile = entry.endsWith(EVENT_FILE_EXT)
          || entry.endsWith(BASELINE_FILE_EXT)
          || entry.endsWith(TEMP_FILE_EXT);
        if (!isKnownFile) continue;

        const file = path.join(dataDir, entry);
        // Attribution is by scopeId alone, and only an exact match deletes. A
        // file too damaged to name any owner is left in place: deleting
        // unattributable files on any scope deletion could destroy a different
        // user's data. That residue is an operator problem, not something one
        // user's deletion may resolve on their behalf.
        if (readScopeId(file) !== scopeId) continue;
        unlinkSync(file);
        // The contract's count is events removed; the baseline (and any temp
        // file of one) is deleted with them but is not an event, and counting
        // it would inflate what the user is told was erased.
        if (!entry.includes(BASELINE_FILE_EXT)) removedEvents++;
      }
      return removedEvents;
    },
  };
}

function createMemoryRepository(): FeedbackRepository {
  const events = new Map<string, FeedbackEvent>();
  const baselines = new Map<string, FeedbackBaseline>();
  return {
    readOne: (id) => events.get(id) ?? null,
    readAll: () => Array.from(events.values()),
    write: (event) => {
      events.set(event.id, event);
    },
    readBaseline: (scopeId) => baselines.get(scopeId) ?? null,
    writeBaseline: (baseline) => {
      baselines.set(baseline.scopeId, baseline);
    },
    removeScope: (scopeId) => {
      let removedEvents = 0;
      for (const entry of Array.from(events.entries())) {
        const [id, event] = entry;
        if (event.scopeId === scopeId && events.delete(id)) removedEvents++;
      }
      baselines.delete(scopeId);
      return removedEvents;
    },
  };
}

/**
 * File-backed store, one JSON file per event under
 * `<MAYBESITTER_DATA_DIR|cwd/.maybesitter>/feedback-events/<id>.feedback.json`,
 * plus one baseline file per scope. `options.dataDir` overrides that leaf
 * directory outright, as in the sibling stores. The directory is resolved per
 * call, so a test may set the env var after constructing the store.
 */
export function createFileFeedbackEventStore(options?: FeedbackEventStoreOptions): FeedbackEventStore {
  return createStore(createFileRepository(() => options?.dataDir ?? defaultDataDir()));
}

/** In-memory store with identical semantics, for tests and ephemeral use. */
export function createInMemoryFeedbackEventStore(): FeedbackEventStore {
  return createStore(createMemoryRepository());
}

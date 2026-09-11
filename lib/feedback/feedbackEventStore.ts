/**
 * Append-only behavioural feedback events, in the user's own tree (UC-1.0c, #142).
 *
 * Holds what the user did with what we proposed. Three properties are
 * structural here rather than conventional, because each of them is a way the
 * log could misrepresent the user:
 *
 *  1. One behaviour is one record. The idempotency key is a digest of
 *     scopeId + subjectId + outcome + occurredAt, and the record id is that
 *     same digest, so a resubmitted outcome cannot occupy a second slot even
 *     if two writers race: they address the same document. append() reads
 *     before writing *inside a transaction* and returns the stored event
 *     untouched, so a retry never moves recordedAt either. A double-counted
 *     outcome is a false claim about how often the user behaved that way.
 *
 *  2. Nothing is rewritten. revoke() adds revokedAt and copies every other
 *     field forward unchanged; a second revoke is refused rather than
 *     re-stamped, because revokedAt records when the *user* made the
 *     correction and overwriting it would misdate their objection.
 *
 *  3. This module observes, it never writes canonical state. It imports no
 *     command handler, no state gateway and not the legacy counter service —
 *     a feedback event must never be able to edit the commitment it describes.
 *     tests/feedback/feedbackBoundaries.test.ts enforces that over the whole
 *     transitive import closure.
 *
 * ── What the move fixes ──────────────────────────────────────────
 *
 * One file per event under `MAYBESITTER_DATA_DIR/feedback-events`. On Cloud
 * Run the history a user is shown on `/settings/privacy/feedback-history` —
 * and the evidence behind every personalization reading — was per-instance and
 * erased on deploy. Events now live at `users/{uid}/feedbackEvents/{id}` and
 * baselines at `users/{uid}/feedbackBaselines/{sha256(scopeId)}`.
 *
 * ── Why some reads are collection-group queries ──────────────────
 *
 * `get` and `revoke` are addressed by event id alone, so they resolve through
 * a group query on the `id` field rather than demanding a scope the caller
 * does not have. The ownership check that makes revocation safe lives in
 * `feedbackHistoryPort`, which compares the found event's scope to the
 * caller's before asking for the write.
 *
 * No function here reads the system clock or any source of randomness. Every
 * timestamp is a parameter and every id is derived, so an append is fully
 * reproducible — which is what makes the idempotency above verifiable rather
 * than merely likely.
 */
import { createHash } from 'node:crypto';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackActor,
  type FeedbackBaseline,
  type FeedbackEvent,
  type FeedbackEventQuery,
  type FeedbackEventStore,
  type FeedbackOutcome,
  type FeedbackSource,
  type LegacyCounterName,
} from '../../src/contracts/v1/feedbackContracts';
import { isIsoTimestamp, isNonEmptyString } from '../evaluation/registry/validationPrimitives';
import {
  FEEDBACK_BASELINES,
  FEEDBACK_EVENTS,
  createMemoryStorage,
  docIdForKey,
  getStorage,
  requireDocId,
  userCol,
  userIdForKey,
  type StorageAdapter,
} from '../storage';

const EVENT_ID_PREFIX = 'fbk_';

/**
 * Ids are derived digests, never caller text, so the pattern can be exact:
 * anything failing it cannot name an event this store ever wrote. It is also
 * the document id, so it has to stay a legal path segment.
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
 * field rather than spread so that nothing a hand-edited record smuggled in
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
 * Shape guard for anything read back. A half-written or hand-edited record must
 * be skipped rather than surface as a partial event, so this checks the schema
 * version and every field a consumer filters or aggregates on.
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

function hasLegacyCounters(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const counters = value as Record<string, unknown>;
  return LEGACY_COUNTER_NAMES.every((name) => {
    const count = counters[name];
    return typeof count === 'number' && Number.isInteger(count) && count >= 0;
  });
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

function eventsCollection(scopeId: string): string {
  return userCol(userIdForKey(scopeId), FEEDBACK_EVENTS);
}

function eventPath(scopeId: string, id: string): string {
  return `${eventsCollection(scopeId)}/${requireDocId(id)}`;
}

/** Scope ids are caller text, so the baseline is keyed by their digest. */
function baselinePath(scopeId: string): string {
  return `${userCol(userIdForKey(scopeId), FEEDBACK_BASELINES)}/${docIdForKey(scopeId)}`;
}

export class StorageFeedbackEventStore implements FeedbackEventStore {
  constructor(private readonly injected?: StorageAdapter) {}

  /** Resolved per call so a test may swap the adapter after construction. */
  private get storage(): StorageAdapter {
    return this.injected ?? getStorage();
  }

  /** An event addressed by id alone; see the header on why this is a group read. */
  private async findById(id: string): Promise<{ path: string; event: FeedbackEvent } | null> {
    const safeId = toSafeId(id);
    if (safeId === null) return null;
    const rows = await this.storage.listGroup<FeedbackEvent>(FEEDBACK_EVENTS, {
      where: [['id', '==', safeId]],
      limit: 1,
    });
    const row = rows[0];
    // The id is re-checked against the record rather than trusted from the
    // path: the id is what a revoke endpoint addresses, so a hand-placed
    // document must not be able to answer a lookup with a different event.
    return row && isFeedbackEvent(row.data) && row.data.id === safeId
      ? { path: row.path, event: freezeEvent(row.data) }
      : null;
  }

  async append(input: AppendFeedbackEventInput, recordedAt: string): Promise<FeedbackEvent> {
    assertTimestamp(recordedAt, 'recordedAt');
    assertValidInput(input);

    const candidate = buildEvent(input, recordedAt);
    const path = eventPath(candidate.scopeId, candidate.id);

    // Replay rather than re-apply, in one transaction so two writers racing the
    // same retry cannot both decide they are first. The stored event is
    // returned untouched: its recordedAt is when we first heard about the
    // behaviour, and a retry is not new information.
    return this.storage.runTransaction(async (tx) => {
      const existing = await tx.get<FeedbackEvent>(path);
      if (existing && isFeedbackEvent(existing)) return freezeEvent(existing);
      tx.set<FeedbackEvent>(path, candidate);
      return candidate;
    });
  }

  async get(id: string): Promise<FeedbackEvent | null> {
    return (await this.findById(id))?.event ?? null;
  }

  async list(query: FeedbackEventQuery): Promise<readonly FeedbackEvent[]> {
    if (!query || typeof query !== 'object') fail('query must be an object');
    if (!isNonEmptyString(query.scopeId)) fail('query.scopeId must be a non-empty string');
    if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1)) {
      fail('query.limit must be a positive integer');
    }

    const rows = await this.storage.list<FeedbackEvent>(eventsCollection(query.scopeId));
    const matches = rows
      .map((row) => row.data)
      .filter(isFeedbackEvent)
      .filter((event) => {
        if (event.scopeId !== query.scopeId) return false;
        // Revoked events are included unless excluded explicitly: a history
        // that hid corrections would hide the evidence that one was applied.
        if (query.includeRevoked === false && event.revokedAt !== undefined) return false;
        return true;
      })
      .map(freezeEvent)
      .sort(byOldestOccurred);

    if (query.newestFirst) matches.reverse();
    return Object.freeze(query.limit === undefined ? matches : matches.slice(0, query.limit));
  }

  async revoke(id: string, at: string): Promise<boolean> {
    assertTimestamp(at, 'at');
    const held = await this.findById(id);
    if (!held) return false;
    // Not an error, but not a second correction either: the first timestamp
    // is when the user objected, and re-stamping it would misdate them.
    if (held.event.revokedAt !== undefined) return false;
    await this.storage.set<FeedbackEvent>(held.path, withRevocation(held.event, at));
    return true;
  }

  async deleteScope(scopeId: string): Promise<number> {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    const collection = eventsCollection(scopeId);
    const rows = await this.storage.list<FeedbackEvent>(collection);
    // Everything under the scope goes, including a document too damaged to
    // parse: it still holds the user's content, and leaving it would make
    // "delete my data" untrue. The count is events removed, which is what the
    // contract's number means — the baseline is deleted with them but is not
    // an event, and counting it would inflate what the user is told was erased.
    for (const row of rows) await this.storage.delete(`${collection}/${row.id}`);
    await this.storage.delete(baselinePath(scopeId));
    return rows.filter((row) => isFeedbackEvent(row.data)).length;
  }

  async readBaseline(scopeId: string): Promise<FeedbackBaseline | null> {
    if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
    const stored = await this.storage.get<FeedbackBaseline>(baselinePath(scopeId));
    // The scopeId is re-checked rather than trusted from the path, so a
    // hand-placed document cannot serve one user's counters to another.
    if (!isFeedbackBaseline(stored) || stored.scopeId !== scopeId) return null;
    return freezeBaseline(stored);
  }

  /**
   * The raw persistence primitive: last write wins. The write-once rule the
   * design states lives in lib/feedback/baselineMigration.ts, which is the
   * only thing that should ever produce a baseline — re-deriving one after
   * dual-write has begun would fold outcomes already in the event log back
   * into the pre-log totals and count them twice.
   */
  async writeBaseline(baseline: FeedbackBaseline): Promise<void> {
    if (!isFeedbackBaseline(baseline)) {
      fail('baseline must carry the current version, a scopeId, five non-negative integer counters, '
        + 'migratedAt, and timestampsUnavailable: true');
    }
    await this.storage.set<FeedbackBaseline>(baselinePath(baseline.scopeId), buildBaseline(baseline));
  }
}

export function createStorageFeedbackEventStore(storage?: StorageAdapter): FeedbackEventStore {
  return new StorageFeedbackEventStore(storage);
}

/**
 * The same implementation over a private in-memory adapter, so a test cannot
 * exercise semantics production does not have.
 */
export function createInMemoryFeedbackEventStore(): FeedbackEventStore {
  return new StorageFeedbackEventStore(createMemoryStorage());
}

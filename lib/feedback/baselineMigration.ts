/**
 * Migration of the pre-event-log counters into a frozen baseline (Sprint 03, #13).
 *
 * lib/services/behaviorFeedbackService.ts records five counters per scope and a
 * single scope-level `updatedAt`. No individual outcome has a time, and two
 * things follow from that:
 *
 *  1. The counters are preserved verbatim and never expanded into events.
 *     Synthesising per-event timestamps would invent history that did not
 *     happen, and would pile every fabricated event onto one instant —
 *     corrupting precisely the windowed aggregates this sprint produces. The
 *     baseline says so in its own data (`timestampsUnavailable: true`) so no
 *     consumer can mistake it for something placeable in a window.
 *
 *  2. The migration is write-once. Dual-write means the legacy counters keep
 *     incrementing after migration while the same outcomes also land in the
 *     event log, so re-reading them later would fold post-migration behaviour
 *     back into the pre-log totals and count it twice. A second call returns
 *     the existing baseline and reads nothing.
 *
 * The legacy store is passed in rather than imported. That module also exports
 * the helpers that increment and clear the counters, and lib/feedback must not
 * be able to reach a writer of the user's data — a feedback record observes
 * behaviour, it never edits it. `BehaviorFeedbackStore` satisfies
 * `LegacyCounterReader` structurally, so the wiring at the call site is:
 *
 *     migrateLegacyBaseline({
 *       scopeId: scopeBehaviorFeedback(options),
 *       reader: createDefaultBehaviorFeedbackStore(),
 *       store: createFileFeedbackEventStore(),
 *       migratedAt: now.toISOString(),
 *     });
 *
 * No function here reads the system clock: `migratedAt` is supplied, like every
 * other timestamp in this feature.
 */
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackBaseline,
  type FeedbackEventStore,
  type LegacyCounterName,
} from '../../src/contracts/v1/feedbackContracts';
import { isIsoTimestamp, isNonEmptyString } from '../evaluation/registry/validationPrimitives';

const LEGACY_COUNTER_NAMES: readonly LegacyCounterName[] = [
  'ignoredSuggestions', 'completedActions', 'delayedActions', 'clarificationSuccesses', 'clarificationFailures',
];

/**
 * The legacy record's shape, restated locally so this module depends on the
 * data rather than on the module that mutates it. Structurally identical to
 * `BehaviorFeedbackRecord`.
 */
export interface LegacyCounterSnapshot {
  readonly ignoredSuggestions: number;
  readonly completedActions: number;
  readonly delayedActions: number;
  readonly clarificationSuccesses: number;
  readonly clarificationFailures: number;
  /** The scope-level timestamp; null until the scope records its first outcome. */
  readonly updatedAt: string | null;
}

/** Read side of the legacy store. `BehaviorFeedbackStore` satisfies it. */
export interface LegacyCounterReader {
  get(scopeId: string): LegacyCounterSnapshot;
}

export interface MigrateLegacyBaselineOptions {
  readonly scopeId: string;
  readonly reader: LegacyCounterReader;
  /**
   * Deliberately narrowed to the baseline half of the store. Migration holds no
   * `append`, so "the counters are never expanded into events" is a property of
   * the type rather than a rule someone has to remember.
   */
  readonly store: Pick<FeedbackEventStore, 'readBaseline' | 'writeBaseline'>;
  readonly migratedAt: string;
}

function fail(message: string): never {
  throw new Error(`feedback baseline: ${message}`);
}

/**
 * Rejects rather than coerces. The legacy store already floors and clamps what
 * it reads from disk, but a silently repaired counter here would report a
 * history the user does not have, and a baseline is the one record that can
 * never be re-derived from events.
 */
function assertValidCounters(snapshot: LegacyCounterSnapshot): void {
  if (!snapshot || typeof snapshot !== 'object') fail('the legacy reader must return a record');
  for (const name of LEGACY_COUNTER_NAMES) {
    const count = snapshot[name];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
      fail(`${name} must be a non-negative integer`);
    }
  }
  if (snapshot.updatedAt !== null && !isIsoTimestamp(snapshot.updatedAt)) {
    fail('updatedAt must be an ISO timestamp or null');
  }
}

function isEmptyHistory(snapshot: LegacyCounterSnapshot): boolean {
  return LEGACY_COUNTER_NAMES.every((name) => snapshot[name] === 0);
}

/**
 * Writes the scope's pre-event-log history, or returns the one already written.
 *
 * Returns null when the scope has no legacy history at all: an all-zero
 * baseline would make a new user's aggregates report inherited totals they
 * never accumulated, and would set `includesMigrationBaseline` for someone
 * whose record starts with the event log.
 */
export function migrateLegacyBaseline(options: MigrateLegacyBaselineOptions): FeedbackBaseline | null {
  if (!options || typeof options !== 'object') fail('options must be an object');
  const { scopeId, reader, store, migratedAt } = options;
  if (!isNonEmptyString(scopeId)) fail('scopeId must be a non-empty string');
  if (!isIsoTimestamp(migratedAt)) fail('migratedAt must be an ISO timestamp');
  if (!reader || typeof reader.get !== 'function') fail('reader must expose get(scopeId)');

  // Write-once, and checked before the legacy store is read at all: the counters
  // that grew since the first migration must not even be observed here.
  const existing = store.readBaseline(scopeId);
  if (existing) return existing;

  const snapshot = reader.get(scopeId);
  assertValidCounters(snapshot);
  if (isEmptyHistory(snapshot)) return null;

  // Built name by name rather than spread, so nothing the reader carried beyond
  // the five known counters can enter the record.
  const counters = {} as Record<LegacyCounterName, number>;
  for (const name of LEGACY_COUNTER_NAMES) counters[name] = snapshot[name];

  const baseline: FeedbackBaseline = {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    counters,
    lastUpdatedAt: snapshot.updatedAt,
    timestampsUnavailable: true,
    migratedAt,
  };
  store.writeBaseline(baseline);
  // Re-read so the caller holds what was actually persisted rather than what we
  // intended to persist, which is the value #14 will aggregate from.
  return store.readBaseline(scopeId);
}

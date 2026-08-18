/**
 * Deterministic aggregation over the behavioural feedback log (Sprint 03, #14).
 *
 * A pure read model over an event list, following `projectLifeState`: it never
 * reads the system clock, `computedAt` comes from `input.now`, and
 * `inputDigest` is a sha256 over an explicitly canonicalized input — so a
 * replay can prove it ran against the same log and compare output byte for
 * byte. Nothing here is persisted: the aggregate is recomputed from the events
 * on every call, which is what keeps the raw log authoritative and makes drift
 * between a cached total and the history that produced it impossible.
 *
 * Determinism is the load-bearing property and it fails quietly, so four
 * decisions are made explicitly rather than left to the runtime:
 *
 *  1. Events are sorted with a *total* comparator before hashing. Array#sort is
 *     stable, which preserves caller order for ties — exactly the dependency
 *     reorder-invariance must not have — so ties fall through to the event id
 *     and finally to the canonical encoding of the whole event.
 *  2. Every timestamp is compared as an instant, never as text. Two ISO strings
 *     naming the same moment with different UTC offsets sort differently as
 *     text than they do in time, so a text comparison silently places events in
 *     the wrong window.
 *  3. Counts are emitted through a frozen outcome order, never through the
 *     iteration order of the accumulator, which is insertion order and
 *     therefore leaks event arrival order into the serialized aggregate.
 *  4. String comparison is code-unit (`compareStrings`), never `localeCompare`:
 *     a locale-dependent order would make the digest depend on the host.
 *
 * The two views — per user and global — share `tallyEvents`, so their windowing
 * and revocation rules cannot diverge.
 */
import { canonicalJson, sha256Hex } from '../evaluation/registry/fingerprint';
import { compareStrings, parseIsoMs } from '../lifeState/fields';
import {
  DEFAULT_FEEDBACK_WINDOW_DAYS,
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackAggregates,
  type FeedbackAggregationInput,
  type FeedbackBaseline,
  type FeedbackEvent,
  type FeedbackOutcome,
  type GlobalFeedbackAggregates,
  type LegacyCounterName,
  type OutcomeCounts,
} from '../../src/contracts/v1/feedbackContracts';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The ECMAScript time range, ±100,000,000 days around the epoch. A window start
 * outside it makes `new Date(...).toISOString()` throw a bare RangeError from
 * deep inside the aggregation, past every validation boundary this module
 * presents to its callers.
 */
const MAX_WINDOW_DAYS = 100_000_000;
const MIN_TIME_MS = -8_640_000_000_000_000;

/**
 * Emission order for outcome counts. Fixed rather than alphabetical or
 * encounter-derived: it runs from the most engaged response to the least, then
 * `undo`, so a reader scans a row of counts in a stable, meaningful order and
 * two logs holding the same outcomes serialize identically.
 */
export const FEEDBACK_OUTCOME_ORDER: readonly FeedbackOutcome[] = Object.freeze([
  'accept',
  'edit',
  'reject',
  'defer',
  'complete',
  'ignore',
  'undo',
]);

const KNOWN_OUTCOMES: ReadonlySet<string> = new Set(FEEDBACK_OUTCOME_ORDER);

/**
 * Fixed iteration order over the legacy counters. `Object.keys` would follow
 * the insertion order of whichever store wrote the baseline, which is not a
 * property of the data.
 */
const LEGACY_COUNTER_ORDER: readonly LegacyCounterName[] = Object.freeze([
  'ignoredSuggestions',
  'completedActions',
  'delayedActions',
  'clarificationSuccesses',
  'clarificationFailures',
]);

/**
 * Legacy counters that have a behavioural counterpart, matching the dual-write
 * mapping in agendaActionService (`done → complete`, `postpone → defer`,
 * `skip → ignore`).
 *
 * `clarificationSuccesses` and `clarificationFailures` are deliberately absent.
 * They are capture-quality signals, not commitment outcomes, and forcing them
 * into the outcome vocabulary would report behaviour the user never performed.
 * They stay readable on the baseline record itself.
 */
const OUTCOME_BY_LEGACY_COUNTER: Readonly<Partial<Record<LegacyCounterName, FeedbackOutcome>>> =
  Object.freeze({
    ignoredSuggestions: 'ignore',
    completedActions: 'complete',
    delayedActions: 'defer',
  });

/** A FeedbackAggregationInput with every optional field resolved. */
export interface ResolvedFeedbackAggregationInput {
  readonly events: readonly FeedbackEvent[];
  readonly baseline: FeedbackBaseline | null;
  readonly scopeId: string;
  readonly now: string;
  readonly windowDays: number;
}

/**
 * The cross-user view's input. It takes no `scopeId` and no baseline: a global
 * aggregate spans scopes, and a baseline belongs to exactly one of them.
 */
export interface GlobalFeedbackAggregationInput {
  readonly events: readonly FeedbackEvent[];
  /** ISO; the aggregation never reads the system clock. */
  readonly now: string;
  readonly windowDays?: number;
}

/* ── Window resolution ──────────────────────────────────────────── */

/**
 * A window of zero or a fraction of a day would silently produce empty windowed
 * counts, which reads as "no behaviour" rather than "bad input", so anything
 * non-positive falls back to the contract default and anything fractional
 * floors to at least one whole day. Huge values are clamped rather than
 * rejected: a caller asking for "everything" should get everything.
 */
export function resolveFeedbackWindowDays(windowDays: number | undefined): number {
  if (typeof windowDays !== 'number' || !Number.isFinite(windowDays) || windowDays <= 0) {
    return DEFAULT_FEEDBACK_WINDOW_DAYS;
  }
  return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.floor(windowDays)));
}

interface FeedbackWindow {
  readonly nowMs: number;
  readonly windowMs: number;
  readonly windowStartMs: number;
  readonly windowStart: string;
  readonly windowDays: number;
}

function requireNowMs(now: string): number {
  const nowMs = parseIsoMs(now);
  if (nowMs === null) {
    throw new TypeError(
      `feedbackAggregation: now must be a valid ISO timestamp, received ${JSON.stringify(now)}`,
    );
  }
  return nowMs;
}

function requireScopeId(scopeId: string): string {
  if (typeof scopeId !== 'string' || scopeId.trim().length === 0) {
    throw new TypeError('feedbackAggregation: scopeId must be a non-empty string');
  }
  return scopeId;
}

/**
 * The window start is clamped into the representable time range as well as the
 * window length being clamped: a `now` near the edge of that range plus a very
 * long window still lands outside it, and the failure mode is a RangeError with
 * no mention of the window that caused it.
 */
function resolveWindow(now: string, windowDays: number | undefined): FeedbackWindow {
  const nowMs = requireNowMs(now);
  const days = resolveFeedbackWindowDays(windowDays);
  const windowMs = days * MS_PER_DAY;
  const windowStartMs = Math.max(MIN_TIME_MS, nowMs - windowMs);
  return {
    nowMs,
    windowMs,
    windowStartMs,
    windowStart: new Date(windowStartMs).toISOString(),
    windowDays: days,
  };
}

/**
 * Window membership, closed at both ends: `[windowStart, now]`.
 *
 * Matches `withinWindow` in lib/lifeState/recentOutcomesView.ts, and the two
 * windows describe the same span of the same user's recent behaviour, so they
 * must agree on their edges. An event exactly on a boundary is a real outcome;
 * excluding either end would drop it from the view entirely with nothing to
 * show that it happened.
 */
function isInWindow(ms: number, window: FeedbackWindow): boolean {
  return ms >= window.windowStartMs && ms <= window.nowMs;
}

/**
 * Which window of length `windowDays`, counted back from `now`, a timestamp
 * falls in. 0 is the current window, -1 the one before it, positive values are
 * after `now` (a skewed clock). Boundaries resolve to the newer window, so the
 * tiling agrees with `isInWindow` about `windowStart` belonging to the current
 * window.
 *
 * Used only to measure lateness: comparing an event's `recordedAt` window with
 * its `occurredAt` window answers "was this stored in a later window than it
 * happened in" without needing a second pass over the log.
 */
function windowIndexOf(ms: number, window: FeedbackWindow): number {
  if (ms > window.nowMs) return Math.ceil((ms - window.nowMs) / window.windowMs);
  if (ms === window.nowMs) return 0;
  return 1 - Math.ceil((window.nowMs - ms) / window.windowMs);
}

/* ── Event validation and ordering ──────────────────────────────── */

function requireEventInstant(event: FeedbackEvent, field: 'occurredAt' | 'recordedAt'): number {
  const ms = parseIsoMs(event[field]);
  if (ms === null) {
    throw new TypeError(
      `feedbackAggregation: event ${JSON.stringify(event.id)} has an unparseable ${field}: ${JSON.stringify(event[field])}`,
    );
  }
  return ms;
}

/**
 * Rejected rather than skipped: an event the aggregation cannot place would be
 * dropped in silence, and the totals would then disagree with the log they
 * claim to summarize while looking entirely healthy.
 */
function requireKnownOutcome(event: FeedbackEvent): FeedbackOutcome {
  if (!KNOWN_OUTCOMES.has(event.outcome)) {
    throw new TypeError(
      `feedbackAggregation: event ${JSON.stringify(event.id)} carries an unknown outcome ${JSON.stringify(event.outcome)}`,
    );
  }
  return event.outcome;
}

/**
 * Foreign-scope events throw instead of being filtered out. A per-user
 * aggregate built from another user's behaviour is wrong in the way that is
 * hardest to notice — the numbers look plausible — and silently dropping the
 * foreign rows would instead hide the caller's over-fetch. Callers pass
 * `store.list({ scopeId })`, so this is a programming error, not a data case.
 */
function requireScopedEvents(
  events: readonly FeedbackEvent[],
  scopeId: string,
): readonly FeedbackEvent[] {
  for (const event of events) {
    if (event.scopeId !== scopeId) {
      throw new TypeError(
        `feedbackAggregation: event ${JSON.stringify(event.id)} belongs to scope ${JSON.stringify(event.scopeId)}, not ${JSON.stringify(scopeId)}`,
      );
    }
  }
  return events;
}

/**
 * Non-finite counters are rejected here, with the counter named, rather than
 * left to surface as an unattributed TypeError from `canonicalJson` — a NaN has
 * no canonical encoding, so the digest could only be computed by hashing
 * something other than the input. Negative and fractional values *are*
 * representable, so they stay in the digest honestly and are contained where
 * they are summed instead (see addBaselineCounters).
 */
function requireScopedBaseline(
  baseline: FeedbackBaseline | null,
  scopeId: string,
): FeedbackBaseline | null {
  if (!baseline) return null;
  if (baseline.scopeId !== scopeId) {
    throw new TypeError(
      `feedbackAggregation: baseline belongs to scope ${JSON.stringify(baseline.scopeId)}, not ${JSON.stringify(scopeId)}`,
    );
  }
  for (const counter of LEGACY_COUNTER_ORDER) {
    const raw = baseline.counters?.[counter];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      throw new TypeError(
        `feedbackAggregation: baseline counter ${counter} must be a finite number, received ${JSON.stringify(raw ?? null)}`,
      );
    }
  }
  return baseline;
}

/**
 * A deterministic, caller-order-independent ordering of the log.
 *
 * Sorted on instants (not text) so the order reflects time rather than
 * spelling, then on the event id, then on the canonical encoding of the event.
 * The last two tiebreaks are what make the comparator *total*: without them,
 * two events sharing an instant would keep their arrival order, and the digest
 * would change when the same log arrived in a different order.
 *
 * Returns a new array; the caller's log is never sorted in place.
 */
function sortEvents(events: readonly FeedbackEvent[]): readonly FeedbackEvent[] {
  const prepared = events.map((event) => ({
    event,
    occurredMs: requireEventInstant(event, 'occurredAt'),
    recordedMs: requireEventInstant(event, 'recordedAt'),
    canonical: canonicalJson(event),
  }));

  prepared.sort(
    (left, right) =>
      left.occurredMs - right.occurredMs ||
      left.recordedMs - right.recordedMs ||
      compareStrings(left.event.id, right.event.id) ||
      compareStrings(left.canonical, right.canonical),
  );

  return prepared.map((entry) => entry.event);
}

/* ── Canonicalization and digest ────────────────────────────────── */

/**
 * The top-level fields are listed explicitly so extra properties on the input
 * object cannot perturb the digest, while events and the baseline are passed
 * whole — `canonicalJson` sorts keys recursively, so a field added to either
 * record later is covered automatically. Enumerating their fields here would
 * silently exclude any new one, and two inputs differing only in it would share
 * a digest: a replay would report "same input" for inputs that are not the
 * same, which is the one thing the digest exists to prevent.
 *
 * The digest covers the *resolved* window, so a call that omits `windowDays`
 * and one that passes the default explicitly do not report a false mismatch.
 * The schema version is part of the preimage so digests recorded under a
 * different schema cannot collide with these.
 */
export function canonicalizeFeedbackInput(input: ResolvedFeedbackAggregationInput): string {
  return canonicalJson({
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    now: input.now,
    scopeId: input.scopeId,
    windowDays: input.windowDays,
    baseline: input.baseline,
    events: sortEvents(input.events),
  });
}

export function computeFeedbackInputDigest(input: ResolvedFeedbackAggregationInput): string {
  return sha256Hex(canonicalizeFeedbackInput(input));
}

/* ── Tally: the one windowing and revocation implementation ─────── */

interface FeedbackTally {
  readonly windowed: Partial<Record<FeedbackOutcome, number>>;
  readonly lifetime: Partial<Record<FeedbackOutcome, number>>;
  revokedCount: number;
  lateEventCount: number;
  /** Distinct scopes with at least one counted event inside the window. */
  readonly windowScopeIds: Set<string>;
}

function increment(counts: Partial<Record<FeedbackOutcome, number>>, outcome: FeedbackOutcome): void {
  counts[outcome] = (counts[outcome] ?? 0) + 1;
}

/**
 * Windowing and revocation for both views.
 *
 * Windows key off `occurredAt` and never `recordedAt`, so an event stored late
 * still lands in the window where the behaviour actually happened. Lateness is
 * then reported separately rather than absorbed, because "we learned about this
 * two weeks after it happened" is information about our pipeline that the
 * counts alone would erase.
 *
 * Lifetime counts every non-revoked event regardless of when it occurred,
 * including one dated after `now` by a skewed clock: it is real history, it
 * simply cannot be counted in a window that has not reached it yet.
 */
function tallyEvents(events: readonly FeedbackEvent[], window: FeedbackWindow): FeedbackTally {
  const tally: FeedbackTally = {
    windowed: {},
    lifetime: {},
    revokedCount: 0,
    lateEventCount: 0,
    windowScopeIds: new Set<string>(),
  };

  for (const event of events) {
    // A revoked event leaves every aggregate — windowed, lifetime, and the
    // lateness measure — and is counted instead, so the user's correction is
    // visible in the output rather than showing up as a silently smaller
    // number. Any revocation stamp counts: honouring a malformed one still
    // errs towards respecting the correction.
    if (typeof event.revokedAt === 'string' && event.revokedAt.length > 0) {
      tally.revokedCount += 1;
      continue;
    }

    const outcome = requireKnownOutcome(event);
    const occurredMs = requireEventInstant(event, 'occurredAt');
    const recordedMs = requireEventInstant(event, 'recordedAt');

    increment(tally.lifetime, outcome);

    if (windowIndexOf(recordedMs, window) > windowIndexOf(occurredMs, window)) {
      tally.lateEventCount += 1;
    }

    if (isInWindow(occurredMs, window)) {
      increment(tally.windowed, outcome);
      tally.windowScopeIds.add(event.scopeId);
    }
  }

  return tally;
}

/**
 * Emits counts in the frozen outcome order, omitting outcomes with no
 * contribution, as the contract specifies. Iterating the accumulator instead
 * would emit keys in insertion order — that is, in the order events happened to
 * arrive — and two identical logs would serialize differently.
 */
function emitCounts(counts: Partial<Record<FeedbackOutcome, number>>): OutcomeCounts {
  const emitted: Partial<Record<FeedbackOutcome, number>> = {};
  for (const outcome of FEEDBACK_OUTCOME_ORDER) {
    const count = counts[outcome];
    if (count !== undefined && count > 0) emitted[outcome] = count;
  }
  return emitted;
}

/**
 * Folds the migration baseline into lifetime totals only.
 *
 * The baseline carries `timestampsUnavailable: true` and no per-event times, so
 * there is no window it can honestly be placed in — not even via
 * `lastUpdatedAt`, which is a scope-level write time, not the moment any of
 * those outcomes happened. Using it would pile years of history onto one
 * instant and corrupt exactly the windowed counts this module exists to
 * produce.
 *
 * A negative or fractional counter contributes nothing instead of poisoning a
 * total: legacy data cannot be re-derived, and a negative lifetime count would
 * be a claim about the user that is not merely imprecise but impossible.
 * Non-finite counters never reach here — requireScopedBaseline rejects them,
 * because they cannot be digested at all.
 */
function addBaselineCounters(
  lifetime: Partial<Record<FeedbackOutcome, number>>,
  baseline: FeedbackBaseline,
): void {
  for (const counter of LEGACY_COUNTER_ORDER) {
    const outcome = OUTCOME_BY_LEGACY_COUNTER[counter];
    if (!outcome) continue;
    const raw = baseline.counters?.[counter];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) continue;
    lifetime[outcome] = (lifetime[outcome] ?? 0) + Math.floor(raw);
  }
}

/* ── Public views ───────────────────────────────────────────────── */

/**
 * The per-user view.
 *
 * Throws rather than defaulting on an unusable `now` or `scopeId`, following
 * `projectLifeState`: an aggregate stamped with a guessed clock or an
 * unattributed scope would look valid, be reported, and quietly fail to replay.
 */
export function aggregateFeedback(input: FeedbackAggregationInput): FeedbackAggregates {
  const scopeId = requireScopeId(input.scopeId);
  const window = resolveWindow(input.now, input.windowDays);
  const baseline = requireScopedBaseline(input.baseline, scopeId);
  const events = sortEvents(requireScopedEvents(input.events, scopeId));

  const tally = tallyEvents(events, window);
  const lifetime = { ...tally.lifetime };
  if (baseline) addBaselineCounters(lifetime, baseline);

  // Key order here is the serialized key order of the aggregate, so it is
  // written once, deliberately, and matches the contract's field order.
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    computedAt: input.now,
    inputDigest: computeFeedbackInputDigest({
      events,
      baseline,
      scopeId,
      now: input.now,
      windowDays: window.windowDays,
    }),
    windowDays: window.windowDays,
    windowStart: window.windowStart,
    windowed: emitCounts(tally.windowed),
    lifetime: emitCounts(lifetime),
    includesMigrationBaseline: baseline !== null,
    revokedCount: tally.revokedCount,
    lateEventCount: tally.lateEventCount,
  };
}

/**
 * The cross-user view: the per-user tally over an unfiltered event set, so the
 * two cannot diverge in their windowing or revocation rules.
 *
 * Counts only. It carries no `scopeId`, no `subjectId`, and no per-event row,
 * because an aggregate across users must never become a way to read one user's
 * history. `scopeCount` is the number of distinct scopes that contributed to
 * the window — a scope with no in-window behaviour is not part of what the
 * window describes, and counting it would deflate any per-scope rate derived
 * from these numbers.
 *
 * There is no lifetime total here on purpose: lifetime includes migration
 * baselines, which are per-scope records this view has no scope to attribute
 * them to.
 */
export function aggregateGlobalFeedback(
  input: GlobalFeedbackAggregationInput,
): GlobalFeedbackAggregates {
  const window = resolveWindow(input.now, input.windowDays);
  const tally = tallyEvents(sortEvents(input.events), window);

  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    computedAt: input.now,
    windowDays: window.windowDays,
    windowStart: window.windowStart,
    windowed: emitCounts(tally.windowed),
    scopeCount: tally.windowScopeIds.size,
  };
}

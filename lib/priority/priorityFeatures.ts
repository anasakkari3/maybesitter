/**
 * Deterministic priority feature extraction (Sprint 04, issue #17).
 *
 * Produces the typed feature vector that `priorityScorer` ranks from. It is a
 * pure read over a single `Commitment`, that commitment's reminders and an
 * explicit `now`: no model call, no I/O, and no system clock — `computedAt`
 * comes from the caller, so a feature vector can be replayed and compared.
 *
 * ## Why the values look the way they do
 *
 * `lib/utils/agendaScoring.ts` is already a live deterministic scorer, and the
 * four knowable features here are exactly the *inputs* its four band
 * components derive from:
 *
 *   | feature        | agendaScoring helper   | what this module must expose        |
 *   |----------------|------------------------|-------------------------------------|
 *   | `urgency`      | `overdueDurationScore` | hours past the earliest overdue time |
 *   | `urgency`      | `timeRemainingScore`   | closeness of the next upcoming time  |
 *   | `importance`   | `importanceScore`      | `commitment.priority.level`          |
 *   | `lateness`     | `repeatedDelayScore`   | snooze count, postponed, deferred    |
 *   | `userPressure` | `ignoredScore`         | whether an ignore exists, and if recent |
 *
 * That is why the numbers here are deliberately *unrounded and unweighted*.
 * `hoursOverdue` is a raw quotient rather than a rounded figure because the
 * scorer rounds once, at `Math.round(hoursOverdue * 6)`; rounding here too
 * would round twice and shift scores by a point on some inputs. Likewise
 * `snoozedCount` is the raw count, not the capped one — the cap is a policy
 * decision that belongs to the scorer, and a feature vector that pre-applied it
 * could never express a new policy.
 *
 * `dueSoonCloseness` is the one value that is *already normalised*, by the
 * caller's `dueSoonWindowMs`. It has to be: closeness is meaningless without the
 * window, and the window is a property of the agenda query rather than of the
 * commitment. A consumer therefore multiplies it by a weight and must not
 * re-window it.
 *
 * ## Missing-value policy
 *
 * A feature whose inputs are absent is `{ known: false, reason: 'NO_DATA' }` and
 * carries no `value` key at all. It is never defaulted to zero. This is the
 * `Field<T>` rule from Sprint 02: absence must not be readable as a measured low
 * value, and a feature that becomes knowable later must change the ranking
 * without any consumer having to distinguish "new" from "previously zero".
 *
 * Concretely:
 *
 *   - **No usable time** — no due date, no reminder time, or every candidate
 *     unparseable — makes `urgency` unknown. A missing or malformed timestamp is
 *     never replaced by `now` or by the epoch.
 *   - **Ignores that cannot be dated** make `userPressure` unknown rather than
 *     counted as stale. Counting them would assert an ignore happened outside
 *     the recency window, which is a claim about time we never recorded.
 *   - **Zero is still a measurement** where the state is authoritative.
 *     `lateness` over a commitment with no snoozes is a known zero, not an
 *     unknown, exactly as Sprint 02's `commitments`/`load` are known-zero over an
 *     empty DomainState: the reminder set was read and found to contain nothing.
 *     Reporting a known zero as unknown hides a real fact.
 *
 * `provenance.source` carries the difference the `known` flag cannot:
 * `'domain_state'` means records were read (even if none contributed),
 * `'absent'` means there was nothing to read.
 *
 * ## dependency and effort
 *
 * Always unknown, and typed `PriorityFeature<never>` so the type itself admits
 * no value. `Commitment` has no dependency field and no effort or estimate
 * field, so there is nothing to extract. Deriving a proxy from title length,
 * description text or similarity would rank a commitment on a signal we never
 * measured, which is the specific failure #17 forbids.
 *
 * ## Feedback aggregates
 *
 * Deliberately not consumed. `FeedbackAggregates` (Sprint 03) is a *scope-wide*
 * outcome tally: it carries `windowed`/`lifetime` counts and no per-subject
 * breakdown at all. Folding a scope's ignore count into one commitment's
 * `userPressure` would attribute other commitments' ignores to this one — an
 * invented per-commitment signal, and one that would also break the
 * behaviour-preserving delegation `agendaScoring` is about to make. Behavioural
 * history belongs in a policy or a future per-subject aggregate, not here.
 */
import type { Commitment, Reminder } from '../../src/domain/stateMachine';
import { compareStrings, knownField, newestTimestamp, parseIsoMs, unknownField } from '../lifeState/fields';
import {
  PRIORITY_SCHEMA_VERSION,
  type FeatureEvidence,
  type ImportanceFeature,
  type LatenessFeature,
  type PriorityFeature,
  type PriorityFeatures,
  type UrgencyFeature,
  type UserPressureFeature,
} from '../../src/contracts/v1/priorityContracts';

const HOUR_MS = 60 * 60 * 1_000;

/** Mirrors `agendaService`'s default agenda window, so the two agree by default. */
export const DEFAULT_DUE_SOON_WINDOW_MS = 24 * HOUR_MS;

/** Mirrors `agendaScoring`'s RECENT_IGNORED_WINDOW_MS. */
export const IGNORED_RECENCY_WINDOW_MS = 24 * HOUR_MS;

/** Reminder states `agendaService` treats as still open when collecting times. */
const OPEN_REMINDER_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'delivered', 'snoozed']);

const IMPORTANCE_LEVELS: ReadonlySet<string> = new Set(['low', 'normal', 'high']);

export interface PriorityFeatureInput {
  readonly commitment: Commitment;
  /**
   * This commitment's reminders. Not filtered by `commitmentId` here, because
   * `agendaScoring` does not filter either and the delegation must not change
   * what the live scorer counts; callers pass the related set, as
   * `agendaService` already does.
   */
  readonly reminders: readonly Reminder[];
  /** ISO instant. Explicit so extraction is replayable; never read from the host. */
  readonly now: string;
  /**
   * The times the agenda considered relevant, matching `AgendaScoringInput`.
   * Supplied by callers that already computed it so extraction sees exactly the
   * same inputs the live scorer does; derived from the commitment otherwise.
   */
  readonly relevantTimes?: readonly string[];
  readonly dueSoonWindowMs?: number;
}

/** A candidate time together with the state it came from. */
interface LabelledTime {
  readonly source: string;
  readonly raw: string;
  readonly ms: number | null;
  readonly index: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Ordering for time candidates: instant first, then the spelling, then the
 * source label. Never text-first — two ISO strings with different UTC offsets
 * sort differently as text than they do in time, which silently places a record
 * in the wrong window. The trailing tie-breaks exist so two spellings of the
 * same instant cannot make the result depend on iteration order.
 */
function compareLabelledTimes(left: LabelledTime, right: LabelledTime): number {
  const leftMs = left.ms as number;
  const rightMs = right.ms as number;
  if (leftMs !== rightMs) return leftMs < rightMs ? -1 : 1;
  const byRaw = compareStrings(left.raw, right.raw);
  if (byRaw !== 0) return byRaw;
  const bySource = compareStrings(left.source, right.source);
  if (bySource !== 0) return bySource;
  return left.index - right.index;
}

function reminderTimesFor(commitment: Commitment, reminders: readonly Reminder[]): string[] {
  return reminders
    .filter((reminder) => reminder.commitmentId === commitment.id && OPEN_REMINDER_STATUSES.has(reminder.status))
    .map((reminder) => reminder.scheduledFor)
    .filter((value): value is string => Boolean(value));
}

/**
 * Every time candidate the commitment offers, *including* unparseable ones.
 *
 * The malformed entries are kept on purpose: they carry no instant and so change
 * no number, but they are the difference between "there was nothing to read" and
 * "we read a due date and it was unusable" — a distinction `provenance.source`
 * reports and a consumer needs in order to chase a bad write.
 */
function candidateTimes(commitment: Commitment, reminders: readonly Reminder[]): string[] {
  return [
    commitment.timeSpec?.dueAt ?? null,
    commitment.timeSpec?.remindAt ?? null,
    ...reminderTimesFor(commitment, reminders),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
}

/**
 * The agenda's relevant times, matching `agendaService.relevantTimes` exactly.
 *
 * Exported so a caller that has only a commitment can reproduce the same list
 * the live agenda builds, rather than inventing a second definition of "which
 * times matter" that would drift from it.
 */
export function deriveRelevantTimes(commitment: Commitment, reminders: readonly Reminder[]): string[] {
  return candidateTimes(commitment, reminders).filter((value) => parseIsoMs(value) !== null);
}

/**
 * Names the state a candidate time came from. Reminder matches are resolved by
 * the lowest id rather than by list position, so reordering the reminder array
 * cannot change the evidence a feature reports.
 */
function labelTime(commitment: Commitment, reminders: readonly Reminder[], raw: string, index: number): string {
  if (commitment.timeSpec?.dueAt === raw) return 'commitment.timeSpec.dueAt';
  if (commitment.timeSpec?.remindAt === raw) return 'commitment.timeSpec.remindAt';

  const matches = reminders
    .filter((reminder) => reminder.scheduledFor === raw)
    .map((reminder) => reminder.id)
    .sort(compareStrings);
  if (matches.length > 0) return `reminder:${matches[0]}`;

  return `relevantTimes[${index}]`;
}

function labelTimes(commitment: Commitment, reminders: readonly Reminder[], times: readonly string[]): LabelledTime[] {
  return times.map((raw, index) => ({
    source: labelTime(commitment, reminders, raw, index),
    raw,
    ms: parseIsoMs(raw),
    index,
  }));
}

function evidenceOf(source: string, observedAt: string | null): FeatureEvidence {
  return { source, observedAt };
}

/** The commitment's own last-touched instant, or null when it is unusable. */
function commitmentObservedAt(commitment: Commitment): string | null {
  return newestTimestamp([commitment.updatedAt]);
}

/* ── urgency ─────────────────────────────────────────────────────── */

/**
 * Mirrors `overdueDurationScore` and `timeRemainingScore`, stopping one step
 * short of each: the earliest overdue instant and the next upcoming instant are
 * selected here, and the weighting and rounding are left to the scorer.
 *
 * A time equal to `now` counts as upcoming, not overdue, matching the live
 * scorer's `< nowMs` / `>= nowMs` split. The boundary is load-bearing: it is the
 * difference between an item reading as maximally due-soon and as barely late.
 */
function buildUrgency(
  labelled: readonly LabelledTime[],
  nowMs: number,
  dueSoonWindowMs: number,
  computedAt: string,
): PriorityFeature<UrgencyFeature> {
  const dated = labelled.filter((item) => item.ms !== null);
  if (dated.length === 0) {
    return unknownField('NO_DATA', null, computedAt, labelled.length > 0);
  }

  const overdue = dated.filter((item) => (item.ms as number) < nowMs).sort(compareLabelledTimes);
  const upcoming = dated.filter((item) => (item.ms as number) >= nowMs).sort(compareLabelledTimes);

  const earliestOverdue = overdue.length > 0 ? overdue[0] : null;
  const nextUpcoming = upcoming.length > 0 ? upcoming[0] : null;

  const hoursOverdue = earliestOverdue === null ? 0 : (nowMs - (earliestOverdue.ms as number)) / HOUR_MS;

  let dueSoonCloseness = 0;
  // A positive test rather than a `<= 0` guard, so a NaN window falls through to
  // zero as well — which is what the live scorer yields for a window it cannot
  // divide by, and what a `<= 0` check would miss.
  if (nextUpcoming !== null && dueSoonWindowMs > 0) {
    const remainingMs = clamp((nextUpcoming.ms as number) - nowMs, 0, dueSoonWindowMs);
    dueSoonCloseness = 1 - remainingMs / dueSoonWindowMs;
  }

  const contributors = [earliestOverdue, nextUpcoming].filter((item): item is LabelledTime => item !== null);
  const evidence = contributors.map((item) => evidenceOf(item.source, item.raw));

  return knownField(
    { value: { hoursOverdue, dueSoonCloseness }, evidence },
    newestTimestamp(contributors.map((item) => item.raw)),
    computedAt,
    true,
  );
}

/* ── importance ──────────────────────────────────────────────────── */

/**
 * Mirrors `importanceScore`, which reads `priority.level` alone. `userSet` is
 * carried alongside it because an explicit choice and an inferred guess are not
 * the same evidence, and a policy that wants to weight them differently should
 * not have to go back to DomainState to find out which it has.
 */
function buildImportance(commitment: Commitment, computedAt: string): PriorityFeature<ImportanceFeature> {
  const priority = commitment.priority;
  if (!priority || !IMPORTANCE_LEVELS.has(priority.level)) {
    return unknownField('NO_DATA', null, computedAt, Boolean(priority));
  }

  const observedAt = commitmentObservedAt(commitment);
  return knownField(
    {
      value: { level: priority.level, userSet: priority.source === 'user_explicit' },
      evidence: [
        evidenceOf('commitment.priority.level', observedAt),
        evidenceOf('commitment.priority.source', observedAt),
      ],
    },
    observedAt,
    computedAt,
    true,
  );
}

/* ── lateness ────────────────────────────────────────────────────── */

/**
 * Mirrors `repeatedDelayScore`. The count is raw: the scorer caps it, and a
 * feature vector that arrived pre-capped could not express a policy that caps
 * differently.
 *
 * Always known. Every input is a field the commitment always carries plus the
 * reminder set the caller supplies, so "no snoozes" is a read that found
 * nothing rather than a gap in what we know.
 */
function buildLateness(
  commitment: Commitment,
  reminders: readonly Reminder[],
  computedAt: string,
): PriorityFeature<LatenessFeature> {
  const snoozed = reminders
    .filter((reminder) => reminder.status === 'snoozed')
    .slice()
    .sort((left, right) => compareStrings(left.id, right.id));

  const value: LatenessFeature = {
    snoozedCount: snoozed.length,
    postponed: commitment.currentAckState === 'postponed' || Boolean(commitment.postponedUntil),
    deferred: commitment.status === 'deferred',
  };

  const observedAt = commitmentObservedAt(commitment);
  const evidence = [
    evidenceOf('commitment.status', observedAt),
    evidenceOf('commitment.currentAckState', observedAt),
    evidenceOf('commitment.postponedUntil', newestTimestamp([commitment.postponedUntil])),
    ...snoozed.map((reminder) => evidenceOf(`reminder:${reminder.id}`, newestTimestamp([reminder.updatedAt]))),
  ];

  return knownField(
    { value, evidence },
    newestTimestamp([commitment.updatedAt, commitment.postponedUntil, ...snoozed.map((item) => item.updatedAt)]),
    computedAt,
    true,
  );
}

/* ── userPressure ────────────────────────────────────────────────── */

interface DatedIgnore {
  readonly source: string;
  readonly raw: string;
  readonly ms: number;
}

/**
 * The instant an ignored reminder is attributed to, following the live
 * scorer's precedence: last update, else delivery, else creation.
 */
function ignoreInstantOf(reminder: Reminder): DatedIgnore | null {
  for (const raw of [reminder.updatedAt, reminder.deliveredAt, reminder.createdAt]) {
    const ms = parseIsoMs(raw);
    if (ms !== null && raw) return { source: `reminder:${reminder.id}`, raw, ms };
  }
  return null;
}

/**
 * Mirrors `ignoredScore` and `latestIgnoredAt`.
 *
 * `ignoredCount` counts only ignores that carry a usable instant. An ignore we
 * cannot date cannot be placed inside or outside the recency window, so counting
 * it would force the scorer to treat it as stale — asserting the ignore happened
 * more than a day ago, which is a claim about time we never recorded. When every
 * ignore is undatable the feature is unknown instead, which scores as zero, just
 * as the live scorer does for the same input.
 *
 * `ignoredRecently` is a signed comparison, not an absolute one: a timestamp in
 * the future reads as recent, matching the live scorer rather than quietly
 * correcting it.
 */
function buildUserPressure(
  commitment: Commitment,
  reminders: readonly Reminder[],
  nowMs: number,
  computedAt: string,
): PriorityFeature<UserPressureFeature> {
  const ignoredReminders = reminders.filter((reminder) => reminder.status === 'ignored');
  const dated = ignoredReminders
    .map(ignoreInstantOf)
    .filter((item): item is DatedIgnore => item !== null)
    .sort((left, right) => compareStrings(left.source, right.source));

  const ackObservedAt = commitmentObservedAt(commitment);
  const ackEvidence = evidenceOf('commitment.currentAckState', ackObservedAt);

  const known = (count: number, latest: DatedIgnore | null, evidence: readonly FeatureEvidence[]) =>
    knownField(
      {
        value: {
          ignoredCount: count,
          ignoredRecently: latest !== null && nowMs - latest.ms <= IGNORED_RECENCY_WINDOW_MS,
        },
        evidence,
      },
      latest === null ? null : latest.raw,
      computedAt,
      true,
    );

  if (dated.length > 0) {
    const latest = dated.reduce((best, item) => {
      if (item.ms > best.ms) return item;
      if (item.ms === best.ms && compareStrings(item.raw, best.raw) < 0) return item;
      return best;
    });
    return known(dated.length, latest, [ackEvidence, ...dated.map((item) => evidenceOf(item.source, item.raw))]);
  }

  // Same fallback order as `latestIgnoredAt`: the ack state answers only when no
  // ignored reminder yielded an instant.
  if (commitment.currentAckState === 'ignored') {
    const ms = parseIsoMs(commitment.updatedAt);
    if (ms === null || !commitment.updatedAt) return unknownField('NO_DATA', null, computedAt, true);
    const latest: DatedIgnore = { source: 'commitment.updatedAt', raw: commitment.updatedAt, ms };
    return known(1, latest, [ackEvidence, evidenceOf('commitment.updatedAt', commitment.updatedAt)]);
  }

  if (ignoredReminders.length > 0) return unknownField('NO_DATA', null, computedAt, true);

  return known(0, null, [ackEvidence]);
}

/* ── entry point ─────────────────────────────────────────────────── */

function requireNowMs(now: string): number {
  const nowMs = parseIsoMs(now);
  if (nowMs === null) {
    throw new TypeError(`extractPriorityFeatures: now must be a valid ISO timestamp, received ${JSON.stringify(now)}`);
  }
  return nowMs;
}

function requireCommitmentId(commitment: Commitment | undefined): string {
  const id = commitment?.id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('extractPriorityFeatures: commitment.id must be a non-empty string');
  }
  return id;
}

/**
 * Extracts the priority feature vector for one commitment.
 *
 * Throws on an unusable `now` or commitment id rather than defaulting, for the
 * same reason `projectLifeState` does: a vector stamped with a guessed clock or
 * an unattributed commitment would look valid, be stored, and quietly fail to
 * replay. That is a different case from a missing *source* timestamp, which
 * yields an unknown feature and is expected in normal operation.
 */
export function extractPriorityFeatures(input: PriorityFeatureInput): PriorityFeatures {
  const nowMs = requireNowMs(input.now);
  const commitmentId = requireCommitmentId(input.commitment);
  const commitment = input.commitment;
  const reminders = input.reminders ?? [];
  const computedAt = input.now;
  const dueSoonWindowMs = input.dueSoonWindowMs ?? DEFAULT_DUE_SOON_WINDOW_MS;
  const times = input.relevantTimes ?? candidateTimes(commitment, reminders);

  return {
    version: PRIORITY_SCHEMA_VERSION,
    commitmentId,
    computedAt,
    urgency: buildUrgency(labelTimes(commitment, reminders, times), nowMs, dueSoonWindowMs, computedAt),
    importance: buildImportance(commitment, computedAt),
    lateness: buildLateness(commitment, reminders, computedAt),
    userPressure: buildUserPressure(commitment, reminders, nowMs, computedAt),
    // Nothing on Commitment expresses either. `absent` rather than
    // `domain_state`: there was no field to read, not a field that read empty.
    dependency: unknownField('NO_DATA', null, computedAt, false),
    effort: unknownField('NO_DATA', null, computedAt, false),
  };
}

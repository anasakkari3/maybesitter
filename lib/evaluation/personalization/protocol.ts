/**
 * The offline evaluation protocol: does personalization help, and where does it
 * harm.
 *
 * ── Every metric carries its baseline, by type ───────────────────
 *
 * `MetricReading` has no shape without `baseline`. That is the acceptance
 * criterion made structural rather than procedural: "usefulness went up" is not
 * a finding, and a report format that lets a number be published without the
 * null profile beside it will eventually publish one.
 *
 * The baseline is a real second run, not a remembered constant — the same
 * cohort scored against `PRODUCT_BASELINE_LEVELS` — so a change to the product
 * defaults moves both columns and the delta stays honest.
 *
 * ── Small samples are a variant, not a small number ──────────────
 *
 * `inconclusive` is its own shape. A slice under the floor reports no value at
 * all, so nothing downstream can average it, plot it, or read it as zero. The
 * house has been here: a report that renders a thin slice as a number is how a
 * measurement becomes a claim.
 *
 * ── The unfair-pressure metric, and why zero is still measured ───
 *
 * The contract makes behavioural inference unable to escalate: any level above
 * `PRODUCT_BASELINE_LEVELS` requires explicit-judgement evidence, and the
 * pressure-bearing dimensions admit explicit outcomes only. So this metric is
 * zero by construction today.
 *
 * It is measured anyway, over the whole cohort, and asserted. A property that
 * holds by construction holds only while the construction does — and this
 * particular construction is one contract edit away from not holding, in the
 * exact direction issue #107 documents the shipped `adaptiveService` already
 * failing. A number nobody re-derives is a claim; this one is re-derived on
 * every run and fails loudly the moment it moves off zero.
 *
 * ── No clock, no unseeded randomness ─────────────────────────────
 *
 * `now` is an argument everywhere. The cohort is seeded and its distribution is
 * asserted by its own suite rather than trusted.
 */
import {
  EXPLICIT_JUDGEMENT_OUTCOMES,
  MIN_OPERATIVE_SAMPLE_EVENTS,
  PERSONALIZATION_WINDOW_LADDER_DAYS,
  PREFERENCE_DIMENSIONS,
  PREFERENCE_DIMENSION_CLASSES,
  PRODUCT_BASELINE_LEVELS,
  isEscalation,
  type Instant,
  type PersonalizationConsent,
  type PersonalizationDeriver,
  type PersonalizationProfile,
  type PreferenceDimension,
  type PreferenceReading,
} from '../../../src/contracts/v1/personalizationContracts';
import { aggregateFeedback } from '../../feedback/feedbackAggregation';
import type { FeedbackEvent } from '../../../src/contracts/v1/feedbackContracts';
import type { EvaluationCohort, EvaluationCohortMember } from './syntheticCohort';

/**
 * The pressure-bearing dimensions, derived from the contract's own class map
 * rather than listed again here. A second list is a second thing to forget.
 */
export const PRESSURE_BEARING_DIMENSIONS = Object.freeze(
  PREFERENCE_DIMENSIONS.filter(
    (dimension) => PREFERENCE_DIMENSION_CLASSES[dimension] === 'pressure_bearing',
  ),
);

/* ── Thresholds ──────────────────────────────────────────────────── */

/**
 * Below this many members a slice reports `inconclusive` rather than a value.
 *
 * Six, not three: three members is one archetype's worth of one locale, and a
 * mean over three synthetic streams reads as a finding while being a
 * coincidence. Named here so the sweep can probe one member either side of it.
 */
export const MIN_SLICE_MEMBERS = 6;

/**
 * Below this many events a *member* contributes nothing but a cold-start
 * observation. Tied to the operative sample floor deliberately: a member who
 * cannot reach an operative reading cannot demonstrate usefulness or harm, and
 * counting them dilutes both columns toward the baseline.
 */
export const MIN_MEMBER_EVENTS = MIN_OPERATIVE_SAMPLE_EVENTS;

export const EVALUATION_METRICS = Object.freeze([
  'usefulness',
  'stability',
  'overfitting',
  'unfair_pressure',
  'cold_start_invention',
] as const);

export type EvaluationMetric = (typeof EVALUATION_METRICS)[number];

export const INCONCLUSIVE_REASONS = Object.freeze([
  'slice_below_member_floor',
  'no_member_reached_a_reading',
] as const);

export type MetricInconclusiveReason = (typeof INCONCLUSIVE_REASONS)[number];

/* ── A reading of one metric on one slice ────────────────────────── */

export type MetricReading =
  | {
      readonly metric: EvaluationMetric;
      readonly kind: 'measured';
      /** 0..1. Direction is per-metric; see each measure function. */
      readonly personalized: number;
      readonly baseline: number;
      readonly delta: number;
      readonly memberCount: number;
    }
  | {
      readonly metric: EvaluationMetric;
      readonly kind: 'inconclusive';
      readonly reason: MetricInconclusiveReason;
      readonly memberCount: number;
    };

/* ── Running a deriver over a cohort ─────────────────────────────── */

const ENABLED = (now: Instant): PersonalizationConsent =>
  Object.freeze({ state: 'enabled', changedAt: now });

function profileFor(
  deriver: PersonalizationDeriver,
  scopeId: string,
  events: readonly FeedbackEvent[],
  now: Instant,
): PersonalizationProfile {
  return deriver({
    scopeId,
    now,
    consent: ENABLED(now),
    rungAggregates: PERSONALIZATION_WINDOW_LADDER_DAYS.map((windowDays) =>
      aggregateFeedback({ events, baseline: null, scopeId, now, windowDays }),
    ),
  });
}

/** The level a consumer would actually apply: operative wins, else the default. */
function effectiveLevel(reading: PreferenceReading | undefined, dimension: PreferenceDimension): string {
  if (reading !== undefined && reading.status === 'operative') return reading.level as string;
  return PRODUCT_BASELINE_LEVELS[dimension];
}

type ReadingsByDimension = Partial<Record<PreferenceDimension, PreferenceReading>>;

function readingsOf(profile: PersonalizationProfile): ReadingsByDimension {
  return profile.readings ?? {};
}

/* ── The five measures ───────────────────────────────────────────── */

/**
 * Usefulness: the share of dimensions where the profile moved *toward* what the
 * member's own explicit judgements asked for.
 *
 * "Asked for" is deliberately narrow — only `EXPLICIT_JUDGEMENT_OUTCOMES` count.
 * A member who ignored everything has not asked for anything, and scoring a
 * quieter product as "useful" for them would be scoring compliance, which is
 * the thing #107 warns about and `NO_ENGAGEMENT_OPTIMIZATION` forbids.
 *
 * The baseline column is the same measure against the null profile, which by
 * definition never moves: its usefulness is 0 unless the member's explicit
 * judgements already agree with the product default.
 */
function measureUsefulness(
  member: EvaluationCohortMember,
  profile: PersonalizationProfile,
): { personalized: number; baseline: number } {
  const explicit = member.events.filter((event) =>
    (EXPLICIT_JUDGEMENT_OUTCOMES as readonly string[]).includes(event.outcome),
  );
  const negativeShare =
    explicit.length === 0
      ? 0
      : explicit.filter((event) => event.outcome === 'reject' || event.outcome === 'undo').length /
        explicit.length;
  // A majority of explicit dissatisfaction is a request for less; a majority of
  // explicit acceptance is a request for no change.
  const wantsQuieter = negativeShare > 0.5;
  const readings = readingsOf(profile);

  let moved = 0;
  for (const dimension of PREFERENCE_DIMENSIONS) {
    const level = effectiveLevel(readings[dimension], dimension);
    const escalated = isEscalation(dimension, level);
    const quieter = escalated === false && level !== PRODUCT_BASELINE_LEVELS[dimension];
    if (wantsQuieter ? quieter : level === PRODUCT_BASELINE_LEVELS[dimension]) moved += 1;
  }
  const personalized = moved / PREFERENCE_DIMENSIONS.length;

  // The null profile: every dimension sits at the default.
  const baselineMoved = wantsQuieter ? 0 : PREFERENCE_DIMENSIONS.length;
  return { personalized, baseline: baselineMoved / PREFERENCE_DIMENSIONS.length };
}

/**
 * Stability: the share of dimensions whose effective level is unchanged when the
 * same member is re-derived over a *longer* window on the same events.
 *
 * A profile that flaps on unchanged behaviour is a harm even when each
 * individual reading is defensible, because the person experiences a product
 * that keeps changing its mind about them. Higher is better; the baseline is
 * trivially 1 and is reported anyway so the column is never absent.
 */
function measureStability(
  member: EvaluationCohortMember,
  deriver: PersonalizationDeriver,
  now: Instant,
  profile: PersonalizationProfile,
): { personalized: number; baseline: number } {
  const later = profileFor(deriver, member.scopeId, member.events, laterInstant(now));
  const before = readingsOf(profile);
  const after = readingsOf(later);
  let same = 0;
  for (const dimension of PREFERENCE_DIMENSIONS) {
    if (effectiveLevel(before[dimension], dimension) === effectiveLevel(after[dimension], dimension)) same += 1;
  }
  return { personalized: same / PREFERENCE_DIMENSIONS.length, baseline: 1 };
}

const DAY_MS = 24 * 60 * 60 * 1_000;
function laterInstant(now: Instant): Instant {
  return new Date(Date.parse(now) + 7 * DAY_MS).toISOString() as Instant;
}

/**
 * Overfitting: the share of dimensions that went **operative** on the primary
 * stream and disagree with the held-out re-sample of the same archetype.
 *
 * Lower is better, and the baseline is 0 by definition — a profile that states
 * nothing cannot be contradicted. Reporting that column anyway is the point: a
 * personalized overfitting rate is only meaningful beside the floor it must not
 * drift from.
 */
function measureOverfitting(
  member: EvaluationCohortMember,
  deriver: PersonalizationDeriver,
  now: Instant,
  profile: PersonalizationProfile,
): { personalized: number; baseline: number } {
  // No held-out stream means nothing can be contradicted, which is a 0 that
  // means "not measured here" — the slice floor is what keeps that from being
  // read as a good score across a cohort with no re-samples at all.
  if (member.resampleEvents === null) return { personalized: 0, baseline: 0 };
  const heldOut = profileFor(deriver, member.scopeId, member.resampleEvents, now);
  const primary = readingsOf(profile);
  const other = readingsOf(heldOut);

  let operative = 0;
  let contradicted = 0;
  for (const dimension of PREFERENCE_DIMENSIONS) {
    const reading = primary[dimension];
    if (reading === undefined || reading.status !== 'operative') continue;
    operative += 1;
    if (effectiveLevel(other[dimension], dimension) !== (reading.level as string)) contradicted += 1;
  }
  return { personalized: operative === 0 ? 0 : contradicted / operative, baseline: 0 };
}

/**
 * Unfair pressure: the share of pressure-bearing dimensions sitting **above**
 * the product baseline without explicit-judgement evidence behind them.
 *
 * Zero by construction, measured anyway. See the header.
 */
function measureUnfairPressure(profile: PersonalizationProfile): { personalized: number; baseline: number } {
  const readings = readingsOf(profile);
  let unfair = 0;
  for (const dimension of PRESSURE_BEARING_DIMENSIONS) {
    const reading = readings[dimension];
    if (reading === undefined || reading.status !== 'operative') continue;
    if (isEscalation(dimension, reading.level as string) !== true) continue;
    const explicitEvidence = reading.evidence.some((entry: { outcome: string }) =>
      (EXPLICIT_JUDGEMENT_OUTCOMES as readonly string[]).includes(entry.outcome),
    );
    if (!explicitEvidence) unfair += 1;
  }
  return { personalized: unfair / PRESSURE_BEARING_DIMENSIONS.length, baseline: 0 };
}

/**
 * Cold-start invention: the share of dimensions a profile states operatively for
 * a member with **no events at all**.
 *
 * Must be zero. A new user is owed a product that does not claim to know them.
 */
function measureColdStart(
  member: EvaluationCohortMember,
  deriver: PersonalizationDeriver,
  now: Instant,
): { personalized: number; baseline: number } {
  if (member.events.length > 0) return { personalized: 0, baseline: 0 };
  const readings: ReadingsByDimension = readingsOf(profileFor(deriver, member.scopeId, [], now));
  const stated = PREFERENCE_DIMENSIONS.filter(
    (dimension) => readings[dimension]?.status === 'operative',
  ).length;
  return { personalized: stated / PREFERENCE_DIMENSIONS.length, baseline: 0 };
}

/* ── Scoring a slice ─────────────────────────────────────────────── */

export interface SliceScore {
  readonly sliceId: string;
  readonly memberCount: number;
  readonly readings: readonly MetricReading[];
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Scores one slice.
 *
 * Members below `MIN_MEMBER_EVENTS` are excluded from the four behavioural
 * metrics and *included* in cold-start — which is the only metric that is about
 * them. Folding them into the rest would drag both columns toward the default
 * and make a thin cohort look stable.
 */
export function scoreSlice(
  sliceId: string,
  members: readonly EvaluationCohortMember[],
  deriver: PersonalizationDeriver,
  now: Instant,
): SliceScore {
  const memberCount = members.length;
  if (memberCount < MIN_SLICE_MEMBERS) {
    return {
      sliceId,
      memberCount,
      readings: EVALUATION_METRICS.map((metric) => ({
        metric,
        kind: 'inconclusive' as const,
        reason: 'slice_below_member_floor' as const,
        memberCount,
      })),
    };
  }

  const scored = members.filter((member) => member.events.length >= MIN_MEMBER_EVENTS);
  const profiles = new Map(scored.map((m) => [m.scopeId, profileFor(deriver, m.scopeId, m.events, now)]));

  const readings: MetricReading[] = [];
  for (const metric of EVALUATION_METRICS) {
    const pool = metric === 'cold_start_invention' ? members : scored;
    if (pool.length === 0) {
      readings.push({ metric, kind: 'inconclusive', reason: 'no_member_reached_a_reading', memberCount });
      continue;
    }
    const pairs = pool.map((member) => {
      const profile = profiles.get(member.scopeId);
      switch (metric) {
        case 'usefulness':
          return measureUsefulness(member, profile!);
        case 'stability':
          return measureStability(member, deriver, now, profile!);
        case 'overfitting':
          return measureOverfitting(member, deriver, now, profile!);
        case 'unfair_pressure':
          return measureUnfairPressure(profile ?? { readings: null } as PersonalizationProfile);
        case 'cold_start_invention':
          return measureColdStart(member, deriver, now);
      }
    });
    const personalized = mean(pairs.map((p) => p.personalized));
    const baseline = mean(pairs.map((p) => p.baseline));
    readings.push({
      metric,
      kind: 'measured',
      personalized,
      baseline,
      delta: personalized - baseline,
      memberCount: pool.length,
    });
  }
  return { sliceId, memberCount, readings };
}

/* ── Slicing ─────────────────────────────────────────────────────── */

export type SliceAxis = 'locale' | 'activity' | 'outcome_mix';

export const SLICE_AXES = Object.freeze(['locale', 'activity', 'outcome_mix'] as const);

/**
 * Slice keys are **measured from the events**, never read from a member's
 * declared archetype or band.
 *
 * A report that slices by the label the generator wrote is a report about the
 * generator. The synthetic members carry their declared coordinates so a test
 * can compare the measured key against them; the protocol never looks.
 */
export function sliceKeyOf(member: EvaluationCohortMember, axis: SliceAxis): string {
  switch (axis) {
    case 'locale':
      return `locale:${member.locale}`;
    case 'activity': {
      const count = member.events.length;
      if (count === 0) return 'activity:none';
      return count < MIN_MEMBER_EVENTS ? 'activity:light' : 'activity:active';
    }
    case 'outcome_mix': {
      const explicit = member.events.filter((event) =>
        (EXPLICIT_JUDGEMENT_OUTCOMES as readonly string[]).includes(event.outcome),
      ).length;
      if (member.events.length === 0) return 'outcome_mix:none';
      return explicit * 2 >= member.events.length ? 'outcome_mix:explicit_led' : 'outcome_mix:behavioral_led';
    }
  }
}

export function sliceCohort(
  cohort: EvaluationCohort,
  axis: SliceAxis,
): ReadonlyMap<string, readonly EvaluationCohortMember[]> {
  const slices = new Map<string, EvaluationCohortMember[]>();
  for (const member of cohort.members) {
    const key = sliceKeyOf(member, axis);
    const bucket = slices.get(key);
    if (bucket === undefined) slices.set(key, [member]);
    else bucket.push(member);
  }
  return slices;
}

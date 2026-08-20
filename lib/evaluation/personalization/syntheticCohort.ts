/**
 * Synthetic evaluation cohort for the personalization protocol (Sprint 10, #43).
 *
 * ── Where every event came from ──────────────────────────────────────────
 *
 * **No real user data is used anywhere in this module or in anything it
 * produces.** Every member is a seeded recombination of the closed vocabularies
 * below; there is no fixture read, no store read, no network call, and no
 * clock — `now` is an explicit argument and every event instant is derived
 * from it. The cohort carries `provenance: 'synthetic'` as a **literal type**,
 * and the report type downstream copies that field rather than restating it,
 * so a synthetic run cannot be quoted as a real one without the quote carrying
 * the label. This is the Sprint 04/06 lesson: a corpus that does not carry its
 * provenance becomes fabricated data the moment someone quotes it.
 *
 * ── The generator is seeded, and its distribution is ASSERTED ────────────
 *
 * Every choice is `sha256Hex(seed, index, field) % bound` — the counter-based
 * derivation `lib/coaching/evaluation/evaluationSet.ts` uses, for its recorded
 * reason: there is no generator state to reshuffle, so two processes agree
 * without exchanging anything but the seed. The member list walks the full
 * archetype × locale × activity cross product rather than drawing members
 * independently, so every combination exists in every seed, forever — the
 * Sprint 08 failure (a generator structurally incapable of the case that
 * matters, behind healthy-looking counts) cannot recur here, and
 * `tests/evaluationPersonalization/syntheticCohort.test.ts` asserts the
 * produced archetypes, locales, activity bands and measured outcome mixes are
 * each **equal as a set** to the declared vocabulary. The distribution is
 * never trusted; it is measured.
 *
 * ── Why the streams look the way they do ─────────────────────────────────
 *
 * Each archetype is an *outcome cycle*, not a story: the protocol's metrics
 * are defined over `FeedbackOutcome` counts, so the archetypes exist to reach
 * every measurable regime — explicit-down (`quiet_seeker`), explicit-hold with
 * behavioural mix (`content_accepter`), behavioural-only (`passive_ignorer`,
 * the #107 regime where pressure dimensions must stay inconclusive), and
 * balanced-explicit (`conflicted`, the low-confidence regime). Activity bands
 * reach the sample-floor regimes: `none` is the cold-start criterion, `light`
 * sits below `MIN_OPERATIVE_SAMPLE_EVENTS` by construction (the bound is
 * derived from the constant, not restated), `active` sits well above it.
 *
 * Streams are stationary on purpose: events sit on a fixed per-member cadence
 * from beyond the evidence horizon to a few days past `now`, so the stability
 * probe (re-deriving at `now + k` days) observes a user whose behaviour has
 * not changed — which is exactly the condition under which profile churn is a
 * harm rather than an update. Events past `now` are invisible to windows at
 * `now` and become visible at the probe instant; events beyond the horizon
 * exercise decay-to-zero. A deterministic minority of events is revoked so the
 * revocation-exclusion path of the real aggregation is exercised rather than
 * assumed.
 *
 * Each member also carries `resampleEvents`: a second, disjointly-seeded
 * stream from the same archetype/band — the held-out re-sample the overfitting
 * metric compares against. Real logged data may supply one (a time split) or
 * `null`; the synthetic cohort always supplies one.
 */
import { createHash } from 'node:crypto';

import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type FeedbackEvent,
  type FeedbackOutcome,
} from '../../../src/contracts/v1/feedbackContracts';
import {
  FEEDBACK_OUTCOME_CLASSES,
  MIN_OPERATIVE_SAMPLE_EVENTS,
  PERSONALIZATION_EVIDENCE_HORIZON_DAYS,
  isInstant,
  type Instant,
} from '../../../src/contracts/v1/personalizationContracts';
import { COACHING_LOCALES } from '../../../src/contracts/v1/coachingContracts';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * The product's locale list, imported rather than restated — a cohort sliced
 * by locales the product does not ship is a report about nobody.
 */
export const COHORT_LOCALES = COACHING_LOCALES;
export type CohortLocale = (typeof COHORT_LOCALES)[number];

/**
 * Where a cohort's members came from. Two members, because the report
 * generator must be pointable at real logged data the moment it exists —
 * but the only constructor in this repo that produces a cohort stamps
 * `'synthetic'` as a literal, so a `'real_logged'` cohort can only enter the
 * pipeline by someone supplying actual logged streams to the protocol.
 */
export type CohortProvenance = 'synthetic' | 'real_logged';

export const COHORT_PROVENANCES = Object.freeze([
  'synthetic',
  'real_logged',
] as const) satisfies readonly CohortProvenance[];

/** One member: the event streams and the metadata a slice can key off. */
export interface EvaluationCohortMember {
  readonly scopeId: string;
  readonly locale: CohortLocale;
  readonly events: readonly FeedbackEvent[];
  /** Held-out re-sample for the overfitting metric; null when none exists. */
  readonly resampleEvents: readonly FeedbackEvent[] | null;
}

export interface EvaluationCohort {
  readonly provenance: CohortProvenance;
  /** The generator seed for a synthetic cohort; null for logged data. */
  readonly syntheticSeed: string | null;
  readonly members: readonly EvaluationCohortMember[];
}

/* ── The synthetic vocabularies ──────────────────────────────────── */

export const SYNTHETIC_ARCHETYPES = Object.freeze([
  'quiet_seeker',
  'content_accepter',
  'passive_ignorer',
  'conflicted',
] as const);
export type SyntheticArchetype = (typeof SYNTHETIC_ARCHETYPES)[number];

export const SYNTHETIC_ACTIVITY_BANDS = Object.freeze(['none', 'light', 'active'] as const);
export type SyntheticActivityBand = (typeof SYNTHETIC_ACTIVITY_BANDS)[number];

/**
 * The outcome cycle each archetype repeats. The cycles are data so the test
 * can measure their explicit/behavioural composition against
 * `FEEDBACK_OUTCOME_CLASSES` instead of trusting this comment:
 *
 *   - `quiet_seeker`     — explicit-heavy, all judgement pulls quieter.
 *   - `content_accepter` — half explicit (accepts), half behavioural: the
 *                          'mixed' outcome regime.
 *   - `passive_ignorer`  — behavioural only: on pressure-bearing dimensions
 *                          this stream must yield `no_admissible_evidence`.
 *   - `conflicted`       — explicit judgements pulling both ways: the
 *                          low-confidence regime.
 */
export const ARCHETYPE_OUTCOME_CYCLES: Readonly<
  Record<SyntheticArchetype, readonly FeedbackOutcome[]>
> = Object.freeze({
  quiet_seeker: Object.freeze(['reject', 'undo', 'reject', 'ignore'] as const),
  content_accepter: Object.freeze(['accept', 'complete', 'accept', 'defer'] as const),
  passive_ignorer: Object.freeze(['ignore', 'defer', 'complete', 'ignore'] as const),
  conflicted: Object.freeze(['accept', 'reject', 'undo', 'edit'] as const),
});

/**
 * Event-count bounds per activity band, derived from the contract's floors so
 * a floor retune moves the fixtures with it (the fixtures-probe-the-constant
 * rule). `light` is `1 .. MIN_OPERATIVE_SAMPLE_EVENTS - 1`: every light member
 * is below the operative sample floor by construction, which is what makes
 * "small samples are labeled inconclusive" reachable from the cohort rather
 * than only from hand-built readings.
 */
export const ACTIVITY_BAND_EVENT_BOUNDS: Readonly<
  Record<SyntheticActivityBand, { readonly min: number; readonly max: number }>
> = Object.freeze({
  none: Object.freeze({ min: 0, max: 0 }),
  light: Object.freeze({ min: 1, max: MIN_OPERATIVE_SAMPLE_EVENTS - 1 }),
  active: Object.freeze({ min: 24, max: 40 }),
});

/** Cadence bounds in days between successive events of one member. */
export const CADENCE_BOUNDS_DAYS = Object.freeze({ min: 3, max: 10 });

/**
 * How many days past `now` the newest event may sit. Kept below the stability
 * probe distance by the protocol's own constant check, so a stationary stream
 * still has behaviour inside the probe's newest window.
 */
export const FUTURE_SPAN_DAYS = 7;

/** One event in this many is revoked, deterministically. */
export const REVOCATION_MODULUS = 9;

export const DEFAULT_COHORT_SEED = 'personalization-eval-seed-1' as const;

/* ── The seeded draw ─────────────────────────────────────────────── */

/**
 * A deterministic non-negative integer below `bound` from `(seed, index,
 * field)`. Counter-based, per `lib/coaching/evaluation/evaluationSet.ts`:
 * no generator object, no state, nothing to reshuffle.
 */
function draw(seed: string, index: number, field: string, bound: number): number {
  const digest = createHash('sha256').update(`${seed} ${index} ${field}`).digest('hex');
  return parseInt(digest.slice(0, 8), 16) % bound;
}

function drawInBounds(
  seed: string,
  index: number,
  field: string,
  bounds: { readonly min: number; readonly max: number },
): number {
  if (bounds.max === bounds.min) return bounds.min;
  return bounds.min + draw(seed, index, field, bounds.max - bounds.min + 1);
}

/* ── Stream construction ─────────────────────────────────────────── */

function requireInstantMs(now: Instant): number {
  if (!isInstant(now)) {
    throw new TypeError(`syntheticCohort: now must be an Instant, received ${JSON.stringify(now)}`);
  }
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) {
    throw new TypeError(`syntheticCohort: now did not parse: ${JSON.stringify(now)}`);
  }
  return ms;
}

/**
 * One member's stream: `count` events on a fixed cadence, newest at
 * `now + futureOffsetDays`, walking back in time. With an active count and the
 * maximum cadence the oldest events land beyond
 * `PERSONALIZATION_EVIDENCE_HORIZON_DAYS`, which is the decay-to-zero case —
 * deliberate, and asserted by the cohort test rather than assumed here.
 */
function buildStream(
  streamSeed: string,
  scopeId: string,
  archetype: SyntheticArchetype,
  band: SyntheticActivityBand,
  nowMs: number,
): readonly FeedbackEvent[] {
  const count = drawInBounds(streamSeed, 0, 'event-count', ACTIVITY_BAND_EVENT_BOUNDS[band]);
  const cadenceDays = drawInBounds(streamSeed, 0, 'cadence-days', CADENCE_BOUNDS_DAYS);
  const futureOffsetDays = draw(streamSeed, 0, 'future-offset', FUTURE_SPAN_DAYS + 1);
  const cycle = ARCHETYPE_OUTCOME_CYCLES[archetype];

  const events: FeedbackEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const outcome = cycle[index % cycle.length];
    const occurredMs = nowMs + (futureOffsetDays - index * cadenceDays) * MS_PER_DAY;
    const occurredAt = new Date(occurredMs).toISOString();
    const explicit = FEEDBACK_OUTCOME_CLASSES[outcome] === 'explicit_judgement';
    const revoked = draw(streamSeed, index, 'revoke', REVOCATION_MODULUS) === 0;
    events.push({
      version: FEEDBACK_EVENT_SCHEMA_VERSION,
      id: `evt/${streamSeed}/${index}`,
      scopeId,
      outcome,
      subjectId: `subject/${streamSeed}/${index}`,
      // Explicit judgements are the user acting in the app; behavioural
      // outcomes arrive as the system observing consequences. The split keeps
      // the streams honest against the contract's outcome classes without the
      // aggregation caring either way.
      actor: explicit ? 'user' : 'system',
      source: explicit ? 'mobile_action' : 'scheduler',
      occurredAt,
      recordedAt: occurredAt,
      idempotencyKey: `idem/${streamSeed}/${index}`,
      ...(revoked ? { revokedAt: occurredAt } : {}),
    });
  }
  return events;
}

/* ── The cohort ──────────────────────────────────────────────────── */

/** A synthetic member keeps its declared coordinates for the tests to check
 * the *measured* slice keys against; the protocol itself never reads them. */
export interface SyntheticCohortMember extends EvaluationCohortMember {
  readonly archetype: SyntheticArchetype;
  readonly declaredActivityBand: SyntheticActivityBand;
}

export interface SyntheticEvaluationCohort extends EvaluationCohort {
  readonly provenance: 'synthetic';
  readonly syntheticSeed: string;
  readonly members: readonly SyntheticCohortMember[];
}

/**
 * Build the full cross-product cohort for `seed` at `now`.
 *
 * Member order is the vocabulary order of the three axes — deterministic,
 * caller-order-free, and stable across seeds so two seeds produce comparable
 * cohorts with different streams. Every member's resample stream comes from a
 * disjoint sub-seed of the same member, so the primary and held-out streams
 * share an archetype and band but no draw.
 */
export function buildSyntheticCohort(seed: string, now: Instant): SyntheticEvaluationCohort {
  const nowMs = requireInstantMs(now);
  const members: SyntheticCohortMember[] = [];
  for (const archetype of SYNTHETIC_ARCHETYPES) {
    for (const locale of COHORT_LOCALES) {
      for (const band of SYNTHETIC_ACTIVITY_BANDS) {
        const scopeId = `synthetic/${seed}/${archetype}/${locale}/${band}`;
        members.push({
          scopeId,
          locale,
          archetype,
          declaredActivityBand: band,
          events: buildStream(`${scopeId}/primary`, scopeId, archetype, band, nowMs),
          resampleEvents: buildStream(`${scopeId}/resample`, scopeId, archetype, band, nowMs),
        });
      }
    }
  }
  return { provenance: 'synthetic', syntheticSeed: seed, members };
}

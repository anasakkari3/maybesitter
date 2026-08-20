/**
 * The cohort/slice report, and the rollback gate that reads it.
 *
 * ── Provenance is on the report, not in the filename ─────────────
 *
 * `provenance` is a required field of `PersonalizationEvaluationReport`, copied
 * from the cohort it was produced from. Sprint 04 shipped an empty judgment
 * corpus and Sprint 06 a synthetic-only dataset, and both became "our results"
 * the moment someone quoted a number out of them. A report that cannot be
 * separated from its provenance cannot be misquoted that way: the label travels
 * with every copy, and the gate below refuses to authorise a release on a
 * synthetic one.
 *
 * The generator is pointable at real logged data the day it exists — build an
 * `EvaluationCohort` with `provenance: 'real_logged'` and pass it in. Nothing
 * here is synthetic-specific. What is *not* done is inventing that data now.
 *
 * ── The gate cannot be fed engagement alone ──────────────────────
 *
 * `NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE` is an invariant of the contract, and it
 * is enforced structurally rather than by review: `RELEASE_GATE_SIGNALS` lists
 * the metrics the gate reads, `evaluateRollbackGate` reads only those, and a
 * test asserts the harm signals are a non-empty subset of them. There is no
 * shape of input that expresses "ship it because people responded more".
 *
 * Note which direction the gate is asymmetric in: usefulness can never *cause*
 * a release on its own, and any harm signal alone can cause a rollback. A gate
 * that could be outvoted by a benefit number is a gate that ships harm when the
 * benefit is large enough.
 */
import {
  PERSONALIZATION_INVARIANTS,
  type Instant,
  type PersonalizationDeriver,
} from '../../../src/contracts/v1/personalizationContracts';
import {
  EVALUATION_METRICS,
  SLICE_AXES,
  scoreSlice,
  sliceCohort,
  type EvaluationMetric,
  type MetricReading,
  type SliceAxis,
  type SliceScore,
} from './protocol';
import type { CohortProvenance, EvaluationCohort } from './syntheticCohort';

/* ── The report ──────────────────────────────────────────────────── */

export interface PersonalizationEvaluationReport {
  readonly provenance: CohortProvenance;
  /** The generator seed for a synthetic cohort; null for logged data. */
  readonly syntheticSeed: string | null;
  readonly generatedAt: Instant;
  readonly memberCount: number;
  readonly overall: SliceScore;
  readonly slices: readonly (SliceScore & { readonly axis: SliceAxis })[];
}

export function buildEvaluationReport(
  cohort: EvaluationCohort,
  deriver: PersonalizationDeriver,
  now: Instant,
): PersonalizationEvaluationReport {
  const slices: (SliceScore & { axis: SliceAxis })[] = [];
  // Axis order and, within an axis, first-appearance order of the key. Neither
  // is sorted: `localeCompare` is forbidden in this repo and both orders are
  // already deterministic given a deterministic cohort.
  for (const axis of SLICE_AXES) {
    for (const [sliceId, members] of Array.from(sliceCohort(cohort, axis))) {
      slices.push({ axis, ...scoreSlice(sliceId, members, deriver, now) });
    }
  }
  return {
    provenance: cohort.provenance,
    syntheticSeed: cohort.syntheticSeed,
    generatedAt: now,
    memberCount: cohort.members.length,
    overall: scoreSlice('overall', cohort.members, deriver, now),
    slices,
  };
}

/* ── The gate ────────────────────────────────────────────────────── */

/**
 * The metrics the gate is allowed to read, and the direction each is read in.
 *
 * `usefulness` is present and is a *benefit* signal, which means it can raise
 * `keep` from `inconclusive` and can never overrule a harm. Everything else is
 * a harm signal with a ceiling.
 */
export const RELEASE_GATE_SIGNALS = Object.freeze({
  usefulness: { direction: 'benefit', threshold: 0.25 },
  stability: { direction: 'benefit', threshold: 0.75 },
  overfitting: { direction: 'harm', threshold: 0.25 },
  unfair_pressure: { direction: 'harm', threshold: 0 },
  cold_start_invention: { direction: 'harm', threshold: 0 },
} as const satisfies Readonly<Record<EvaluationMetric, { direction: 'benefit' | 'harm'; threshold: number }>>);

export const HARM_SIGNALS = Object.freeze(
  EVALUATION_METRICS.filter((metric) => RELEASE_GATE_SIGNALS[metric].direction === 'harm'),
);

export type RollbackVerdict = 'keep' | 'rollback' | 'inconclusive';

export interface RollbackReason {
  readonly sliceId: string;
  readonly metric: EvaluationMetric;
  readonly measured: number;
  readonly threshold: number;
}

export interface RollbackDecision {
  readonly verdict: RollbackVerdict;
  readonly reasons: readonly RollbackReason[];
  readonly notes: readonly string[];
}

function readingOf(score: SliceScore, metric: EvaluationMetric): MetricReading | undefined {
  return score.readings.find((reading) => reading.metric === metric);
}

/**
 * Decides keep / rollback / inconclusive.
 *
 * **Any** harm breach on **any** slice is a rollback, including a slice that is
 * a small minority of the cohort. That is the whole reason the report is sliced:
 * a harm concentrated in one locale is invisible in an average, and a gate that
 * only reads the overall score would ship it.
 *
 * A synthetic report can never return `keep`. It can still return `rollback` —
 * a harm found in simulation is a real finding — and that asymmetry is
 * deliberate: simulation can falsify, it cannot authorise.
 */
export function evaluateRollbackGate(report: PersonalizationEvaluationReport): RollbackDecision {
  const reasons: RollbackReason[] = [];
  const notes: string[] = [];

  for (const score of [report.overall, ...report.slices]) {
    for (const metric of HARM_SIGNALS) {
      const reading = readingOf(score, metric);
      if (reading === undefined || reading.kind !== 'measured') continue;
      const { threshold } = RELEASE_GATE_SIGNALS[metric];
      if (reading.personalized > threshold) {
        reasons.push({ sliceId: score.sliceId, metric, measured: reading.personalized, threshold });
      }
    }
  }
  if (reasons.length > 0) {
    return { verdict: 'rollback', reasons, notes: ['a harm ceiling was exceeded on at least one slice'] };
  }

  if (report.provenance !== 'real_logged') {
    notes.push(
      'this report is not from logged user data, so it cannot authorise a release; ' +
        'it can only refuse one',
    );
    return { verdict: 'inconclusive', reasons, notes };
  }

  for (const metric of EVALUATION_METRICS) {
    if (RELEASE_GATE_SIGNALS[metric].direction !== 'benefit') continue;
    const reading = readingOf(report.overall, metric);
    if (reading === undefined || reading.kind !== 'measured') {
      notes.push(`${metric} was inconclusive overall`);
      return { verdict: 'inconclusive', reasons, notes };
    }
    if (reading.personalized < RELEASE_GATE_SIGNALS[metric].threshold) {
      notes.push(`${metric} at ${reading.personalized} is below its ${RELEASE_GATE_SIGNALS[metric].threshold} bar`);
      return { verdict: 'inconclusive', reasons, notes };
    }
  }
  return { verdict: 'keep', reasons, notes: ['no harm ceiling exceeded and every benefit bar met'] };
}

/**
 * The invariants this gate is responsible for, named so a test can enumerate
 * them against the contract's list rather than trusting this comment.
 */
export const GATE_ENFORCED_INVARIANTS = Object.freeze(
  PERSONALIZATION_INVARIANTS.filter((invariant) => invariant === 'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE'),
);

import type { NextStepEvidenceCode, NextStepEvidenceContract } from '../../src/contracts/v1/nextStepContracts';

/**
 * The English label for an evidence code (UC-2.R3 #173).
 *
 * ── One source, two renderings ───────────────────────────────────
 *
 * The code is what the phone reads and the label is what the alpha quality
 * harness and the trace recorder match on. Producing them as two parallel
 * lists is how they drift: a rule that pushes a label and forgets a code
 * leaves the user with a reason the app cannot say, and nothing fails.
 *
 * So the rules emit codes, and every label in the system comes from here. The
 * strings are the ones `nextStepBaseline` and `nextStepArms` used before,
 * character for character, because `alphaQualityHarness` greps them — with one
 * deliberate exception, below.
 *
 * ── The one word this product does not say ───────────────────────
 *
 * `overdue` is a ranking signal and it stays one: `latenessBand` is the first
 * key the baseline sorts on, and taking it away would make the recommender
 * blind to the thing the user most needs surfaced. What changed (owner
 * decision, 2026-09-15, #383) is the *word*. Onboarding promises «There is no
 * "overdue". Only active, done, moved, or dropped on purpose.» and a device run
 * caught the Next Step card answering "Based on overdue and importance: high"
 * about a commitment Today and Upcoming both said did not exist.
 *
 * The code keeps its name — it is internal, it is what the phone matches on,
 * and renaming it would churn a schema, a fixture and three locale tables for
 * nothing. The label says what is true without passing sentence on the person:
 * the thing has been waiting since its time went by. `tests/mobile/latenessCopy.test.ts`
 * fails on the word anywhere a user could read it, in any of the three
 * languages.
 */
const LABELS: Record<NextStepEvidenceCode, (params: NextStepEvidenceContract['params']) => string> = {
  overdue: () => 'waiting since its time passed',
  due_within_24h: () => 'due within 24 hours',
  due_within_7d: () => 'due within 7 days',
  importance: (params) => `importance: ${params?.level ?? 'normal'}`,
  importance_estimated: (params) => `estimated importance: ${params?.level ?? 'normal'}`,
  fits_focus_time: () => 'in a time you set aside to focus',
  effort: (params) => `effort: ${params?.minutes ?? 0} minutes`,
  outside_usual_hours: () => 'outside your usual hours',
  short_for_end_of_day: () => 'short enough for the end of the day',
  fits_before_due: () => 'fits before it is due',
  usually_finishes: () => 'you usually finish these',
  often_set_aside: () => 'you often set these aside',
  usual_productive_time: () => 'a time you usually get things done',
};

export function evidenceLabel(evidence: NextStepEvidenceContract): string {
  return LABELS[evidence.code](evidence.params);
}

export function evidenceLabels(evidence: readonly NextStepEvidenceContract[]): string[] {
  return evidence.map(evidenceLabel);
}

/** Every code, so a test can assert each has a label and each has copy on the phone. */
export const NEXT_STEP_EVIDENCE_CODES = Object.keys(LABELS) as NextStepEvidenceCode[];

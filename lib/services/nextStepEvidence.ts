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
 * strings are exactly the ones `nextStepBaseline` and `nextStepArms` used
 * before, character for character, because `alphaQualityHarness` greps them.
 */
const LABELS: Record<NextStepEvidenceCode, (params: NextStepEvidenceContract['params']) => string> = {
  overdue: () => 'overdue',
  due_within_24h: () => 'due within 24 hours',
  due_within_7d: () => 'due within 7 days',
  importance: (params) => `importance: ${params?.level ?? 'normal'}`,
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

import type { PreferenceMemoryStore } from '../../src/domain/memory/preferenceMemoryStore.ts';
import type { FactMemoryStore } from '../../src/domain/memory/factMemoryStore.ts';
import type { PreferenceTraceEntry } from './nextStepArms.ts';

export type DecisionFeedbackOutcome = 'accept' | 'dismiss' | 'edit' | 'defer' | 'done';

const ACCEPT_STEP = 0.03;
const REJECT_STEP = -0.05;
const POSITIVE_OUTCOMES: DecisionFeedbackOutcome[] = ['accept', 'done'];

function stepFor(outcome: DecisionFeedbackOutcome): number {
  return POSITIVE_OUTCOMES.includes(outcome) ? ACCEPT_STEP : REJECT_STEP;
}

/**
 * Benchmark-only: nudges the confidence of whichever facts/preferences contributed
 * to a decision, bounded and reversible. Never called from live analytics or the
 * V03 pilot's decision recording path — see ADR 0002.
 */
export function applyDecisionFeedback(
  stores: { preferenceStore: PreferenceMemoryStore; factStore: FactMemoryStore },
  trace: readonly PreferenceTraceEntry[],
  outcome: DecisionFeedbackOutcome,
  reason: string,
): void {
  const step = stepFor(outcome);
  for (const entry of trace) {
    if (entry.effect === 'veto') continue;
    if (entry.kind === 'preference') {
      stores.preferenceStore.adjustConfidence(entry.id, step, reason);
    } else {
      stores.factStore.adjustConfidence(entry.id, step, reason);
    }
  }
}

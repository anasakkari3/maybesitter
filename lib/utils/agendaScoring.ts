import type { Commitment, Reminder } from '../../src/domain/stateMachine';
import { extractPriorityFeatures } from '../priority/priorityFeatures';
import { scorePriority } from '../priority/priorityScorer';
import { DEFAULT_PRIORITY_POLICY } from '../priority/priorityPolicy';
import type { PriorityReason } from '../../src/contracts/v1/priorityContracts';

export type AgendaScoringReason = 'overdue' | 'due_soon' | 'pending' | 'active';

export interface AgendaScoringInput {
  commitment: Commitment;
  reminders: readonly Reminder[];
  reason: AgendaScoringReason;
  now: Date;
  relevantTimes: readonly string[];
  dueSoonWindowMs: number;
}

/**
 * Agenda urgency, delegated to the Priority Engine (Sprint 04).
 *
 * This function used to own the scoring arithmetic. It now extracts a feature
 * vector and scores it, so the product has exactly one ranking implementation
 * rather than two that can drift — and so the same numbers can be explained
 * component by component, which is what `scorePriority` returns and this
 * signature cannot.
 *
 * The weights in DEFAULT_PRIORITY_POLICY transcribe the arithmetic this file
 * previously contained, and tests/priority/priorityDelegationEquivalence.test.ts
 * asserts the two agree across every band, both caps, and the boundary cases.
 *
 * Two intentional behaviour changes. A commitment whose `id` is empty or blank
 * now throws rather than being scored: a ranking entry that cannot be
 * identified cannot be acted on, and the id is what every downstream consumer
 * keys by.
 *
 * And an unparseable `now` now throws. It
 * previously flowed through as NaN, silently yielding a plausible-but-wrong
 * score (7300 where a valid clock gave 7720) — every time feature dropped and
 * every ignore treated as stale. Producing a confident ranking from a nonsense
 * clock is worse than refusing, and no caller relied on it: nothing tested it.
 */
export function calculateAgendaUrgencyScore(input: AgendaScoringInput): number {
  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new TypeError('agenda scoring: `now` must be a valid Date');
  }

  const features = extractPriorityFeatures({
    commitment: input.commitment,
    reminders: input.reminders,
    now: input.now.toISOString(),
    relevantTimes: input.relevantTimes,
    dueSoonWindowMs: input.dueSoonWindowMs,
  });

  return scorePriority({
    features,
    reason: input.reason as PriorityReason,
    policy: DEFAULT_PRIORITY_POLICY,
  }).total;
}

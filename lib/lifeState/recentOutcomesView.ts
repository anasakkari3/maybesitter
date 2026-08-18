/**
 * RecentOutcomesView: what actually happened to commitments in the last window.
 *
 * Derived from DomainState only. `behaviorFeedbackService` holds outcome counters
 * without per-event timestamps, so it cannot answer "in the last 14 days" at all;
 * projecting from the timestamps DomainState already carries keeps this field
 * honest and lets Sprint 03 supply a richer source behind the same shape.
 *
 * Unknown only when there are no commitments at all. Once commitments exist,
 * "nothing was completed in 14 days" is a real behavioural signal and must not be
 * reported as absence — the whole point of the window is to make that visible.
 */
import type { AckState } from '../../src/domain/stateMachine';
import type { Field, RecentOutcomesView } from '../../src/contracts/v1/lifeStateContracts';
import type { CommitmentFact } from './commitmentFacts';
import { knownField, newestTimestamp, parseIsoMs, unknownField } from './fields';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/**
 * Fixed emission order, for the same reason as commitment statuses: encounter
 * order would leak commitment insertion order into the serialized projection.
 */
const ACK_STATE_ORDER: readonly AckState[] = Object.freeze([
  'not_seen',
  'seen',
  'aware',
  'postponed',
  'completed',
  'ignored',
]);

/**
 * Ack states that record a decision the user made. `not_seen`, `seen` and
 * `aware` describe an item still in flight, so counting them as outcomes would
 * inflate the window with non-events.
 */
const TERMINAL_ACK_STATES: readonly AckState[] = Object.freeze(['postponed', 'completed', 'ignored']);

interface OutcomeTally {
  completedCount: number;
  postponedCount: number;
  ignoredCount: number;
  droppedCount: number;
  ackCounts: Partial<Record<AckState, number>>;
  contributingTimestamps: string[];
}

/**
 * When a commitment reached a terminal status. `completedAt`/`droppedAt` are the
 * authoritative event times; `updatedAt` is the fallback for the terminal
 * statuses that carry no dedicated timestamp (`missed`, `archived`) and for
 * records written before those fields were populated.
 */
function statusOutcomeAt(fact: CommitmentFact): string | null {
  if (!fact.isTerminal) return null;
  const { status, completedAt, droppedAt, updatedAt } = fact.commitment;
  if (status === 'completed') return completedAt || updatedAt;
  if (status === 'dropped') return droppedAt || updatedAt;
  return updatedAt;
}

function withinWindow(at: string | null, windowStartMs: number, nowMs: number): boolean {
  const ms = parseIsoMs(at);
  return ms !== null && ms >= windowStartMs && ms <= nowMs;
}

export function buildRecentOutcomesView(
  facts: readonly CommitmentFact[],
  windowDays: number,
  nowMs: number,
  computedAt: string
): Field<RecentOutcomesView> {
  if (facts.length === 0) {
    return unknownField('NO_DATA', null, computedAt, false);
  }

  const windowStartMs = nowMs - windowDays * MS_PER_DAY;
  const tally: OutcomeTally = {
    completedCount: 0,
    postponedCount: 0,
    ignoredCount: 0,
    droppedCount: 0,
    ackCounts: {},
    contributingTimestamps: [],
  };

  for (const fact of facts) {
    const statusAt = statusOutcomeAt(fact);
    if (withinWindow(statusAt, windowStartMs, nowMs)) {
      if (fact.commitment.status === 'completed') tally.completedCount += 1;
      if (fact.commitment.status === 'dropped') tally.droppedCount += 1;
      tally.contributingTimestamps.push(statusAt as string);
    }

    // Ack outcomes are tracked separately from status outcomes: a postponement
    // is an outcome the user produced without the commitment ever closing.
    //
    // Dropping is excluded because Drop sets currentAckState to 'completed'
    // (stateMachine.ts) purely to mean "no longer awaiting acknowledgement".
    // Counting that ack would report an abandoned commitment as a completed
    // one — the opposite of what happened, and to a consumer measuring whether
    // the user is finishing things, actively misleading.
    const ackState = fact.commitment.currentAckState;
    const ackIsDropArtifact = fact.commitment.status === 'dropped';
    if (!ackIsDropArtifact
      && TERMINAL_ACK_STATES.includes(ackState)
      && withinWindow(fact.commitment.updatedAt, windowStartMs, nowMs)) {
      tally.ackCounts[ackState] = (tally.ackCounts[ackState] || 0) + 1;
      if (ackState === 'postponed') tally.postponedCount += 1;
      if (ackState === 'ignored') tally.ignoredCount += 1;
      tally.contributingTimestamps.push(fact.commitment.updatedAt);
    }
  }

  const countsByAckState: Partial<Record<AckState, number>> = {};
  for (const ackState of ACK_STATE_ORDER) {
    const count = tally.ackCounts[ackState];
    if (count !== undefined) countsByAckState[ackState] = count;
  }

  const view: RecentOutcomesView = {
    windowDays,
    windowStart: new Date(windowStartMs).toISOString(),
    completedCount: tally.completedCount,
    postponedCount: tally.postponedCount,
    ignoredCount: tally.ignoredCount,
    droppedCount: tally.droppedCount,
    countsByAckState,
  };

  return knownField(view, newestTimestamp(tally.contributingTimestamps), computedAt, true);
}

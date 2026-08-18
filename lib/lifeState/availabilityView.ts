/**
 * AvailabilityView: busy time only, never free time.
 *
 * There is no inbound calendar in this repo — the ICS feed is outbound — so the
 * only thing the system can honestly say about the user's time is "here are the
 * commitments we know are pinned to a moment". An empty busy list therefore must
 * not be published as a value: `{ busyWindows: [] }` reads as "the user is free",
 * which is a claim nothing in the repo can support. That case is unknown, and
 * the reason distinguishes "no commitments at all" from "commitments exist but
 * none is pinned to a time".
 */
import type { AvailabilityView, BusyWindow, Field } from '../../src/contracts/v1/lifeStateContracts';
import type { CommitmentFact } from './commitmentFacts';
import { compareStrings, knownField, newestTimestamp, parseIsoMs, unknownField } from './fields';

/**
 * Windows are not filtered against `now`. A deadline that has passed was still a
 * window during which the user had a commitment, and the consumer has
 * `computedAt` to filter with; dropping them here would quietly hide overdue work
 * from anything reading availability alone.
 */
function busyWindowsFrom(openFacts: readonly CommitmentFact[]): BusyWindow[] {
  return openFacts
    .filter((fact) => fact.deadlineAt !== null)
    .map((fact): BusyWindow => ({
      commitmentId: fact.commitment.id,
      startsAt: fact.deadlineAt as string,
      // DomainState carries no duration, so the end of a window is genuinely
      // unknown rather than equal to its start.
      endsAt: null,
      timezone: fact.commitment.timeSpec.timezone,
      // A dueAt constrains the user's time whatever the timeSpec calls itself,
      // so anything not declared a scheduled_event is treated as a deadline.
      kind: fact.commitment.timeSpec.kind === 'scheduled_event' ? 'scheduled_event' : 'due_by',
    }))
    .sort((left, right) => (
      (parseIsoMs(left.startsAt) as number) - (parseIsoMs(right.startsAt) as number) ||
      compareStrings(left.commitmentId, right.commitmentId)
    ));
}

export function buildAvailabilityView(facts: readonly CommitmentFact[], computedAt: string): Field<AvailabilityView> {
  if (facts.length === 0) {
    return unknownField('NO_DATA', null, computedAt, false);
  }

  const openFacts = facts.filter((fact) => fact.isOpen);
  const busyWindows = busyWindowsFrom(openFacts);

  if (busyWindows.length === 0) {
    // Records were read and none constrained the user's time: evidence exists,
    // it just does not reach the bar this field needs.
    return unknownField(
      'INSUFFICIENT_DATA',
      newestTimestamp(facts.map((fact) => fact.commitment.updatedAt)),
      computedAt,
      true
    );
  }

  const view: AvailabilityView = {
    busyWindows,
    unscheduledCommitmentCount: openFacts.filter((fact) => fact.deadlineAt === null).length,
  };

  return knownField(view, newestTimestamp(openFacts.map((fact) => fact.commitment.updatedAt)), computedAt, true);
}

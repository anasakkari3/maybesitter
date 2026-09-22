/**
 * Progress, counted from the canonical entities (#526, slice 2).
 *
 * ── "Do not let the model set 73% complete" ─────────────────────
 *
 * The issue's rule, and the shape of this module is the answer to it. There is
 * no percentage anywhere in `GoalGraphProgress`, no score, and no field a
 * writer could put a number into — because there is no writer. This function
 * reads the links, reads the Commitments and the Habit occurrences they point
 * at, and counts. Called twice on an unchanged account it returns the same
 * answer; called after the user completes a commitment it returns a different
 * one, without anything having been recomputed, synced or stored.
 *
 * That is also the whole of "linked Commitment completion changes derived
 * progress automatically": a link carries an id and nothing else, so there is
 * no copy of the commitment's status that could be the stale one.
 *
 * ── Why the period is a parameter ───────────────────────────────
 *
 * "Habit occurrences achieved this period" needs to know what this period is,
 * and this module does not have a clock — for the reason the planner does not:
 * a progress figure that changed with the wall clock could not be compared
 * across two reads, and no test could pin it. The caller knows the user's zone
 * and this module deliberately does not.
 *
 * A habit with no period asked for counts zero achieved, not "all of them":
 * the honest answer to a question nobody scoped.
 */
import type {
  GoalGraphProgress,
  GoalNodeLink,
  GoalNodeProgress,
  GoalProgressPeriod,
} from '../../src/contracts/v1/goalGraphContracts';
import type { DomainState } from '../../src/domain/stateMachine';
import { getParticipantStateSnapshot } from '../services/mobile/participantState';
import { createHabitServices, type HabitServices } from '../services/habits/habitService';
import { createStorageGoalNodeLinkStore, type GoalNodeLinkStore } from './linkStore';

/**
 * The commitment statuses that count as done.
 *
 * `completed` only. `dropped` is a commitment the user decided against, and
 * counting it would tell somebody they are further along for having given up;
 * `missed` is the opposite of progress by name. Stated as a set rather than
 * inline so that the one place this judgement is made is findable.
 */
const COMPLETED_COMMITMENT_STATUSES: ReadonlySet<string> = new Set(['completed']);

export interface DeriveGoalProgressRequest {
  readonly scopeId: string;
  readonly goalMemoryId: string;
  /** The window "this period" means for habit occurrences. Optional. */
  readonly period?: GoalProgressPeriod;
  /** The caller's instant, carried onto the answer. Never read from a clock. */
  readonly derivedAt: string;
}

export interface DeriveGoalProgressDependencies {
  readonly links?: GoalNodeLinkStore;
  readonly habits?: HabitServices;
  /** The domain state reader, injected so a test need not stub the adapter. */
  readonly readDomainState?: (scopeId: string) => Promise<DomainState>;
}

export async function deriveGoalGraphProgress(
  request: DeriveGoalProgressRequest,
  dependencies: DeriveGoalProgressDependencies = {},
): Promise<GoalGraphProgress> {
  const links = dependencies.links ?? createStorageGoalNodeLinkStore();
  const habits = dependencies.habits ?? createHabitServices();
  const readState = dependencies.readDomainState ?? getParticipantStateSnapshot;

  const all = await links.list(request.scopeId, request.goalMemoryId);
  // A `pending` link is a confirmation that did not finish. It names no
  // entity, so there is nothing to count — and counting it as outstanding work
  // would make a crashed request look like something the user still has to do.
  const linked = all.filter((link): link is GoalNodeLink & { entityId: string } =>
    link.state === 'linked' && link.entityId !== null);

  const needsCommitments = linked.some((link) => link.entityKind === 'commitment');
  // Read once, outside the loop, and only when something needs it: the domain
  // snapshot is the whole account's commitments and reminders.
  const state = needsCommitments ? await readState(request.scopeId) : null;

  const nodes: GoalNodeProgress[] = [];
  for (const link of linked) {
    if (link.entityKind === 'commitment') {
      const commitment = state?.commitments[link.entityId];
      nodes.push({
        nodeKey: link.nodeKey,
        entityKind: 'commitment',
        entityId: link.entityId,
        // `missing` rather than an error: a user may delete a commitment a
        // goal node points at, and a goal screen that threw because of it
        // would be a deletion breaking an unrelated page.
        status: commitment?.status ?? 'missing',
        completed: commitment !== undefined && COMPLETED_COMMITMENT_STATUSES.has(commitment.status),
      });
      continue;
    }
    nodes.push(await habitProgress(habits, request, link));
  }

  nodes.sort((left, right) => (left.nodeKey < right.nodeKey ? -1 : left.nodeKey > right.nodeKey ? 1 : 0));
  return Object.freeze({
    scopeId: request.scopeId,
    goalMemoryId: request.goalMemoryId,
    confirmedCount: nodes.length,
    completedCount: nodes.filter((node) => node.completed).length,
    nodes: Object.freeze(nodes),
    derivedAt: request.derivedAt,
  });
}

/**
 * A habit node is done for the period when it has met its own minimum.
 *
 * `minimumOccurrences` is the habit's own field — what the person said the
 * habit is met at — rather than a threshold this module chose. A habit that
 * has been deleted reports a target of zero and is not complete: zero of zero
 * would otherwise read as "achieved", which is the one wrong answer.
 */
async function habitProgress(
  habits: HabitServices,
  request: DeriveGoalProgressRequest,
  link: GoalNodeLink & { entityId: string },
): Promise<GoalNodeProgress> {
  const definition = (await habits.habits.list(request.scopeId))
    .find((habit) => habit.habitId === link.entityId);
  const occurrences = definition === undefined
    ? []
    : await habits.occurrences.listForHabit(request.scopeId, link.entityId);
  const period = request.period;
  const completedOccurrences = occurrences.filter((occurrence) =>
    occurrence.state === 'completed'
    && period !== undefined
    && occurrence.localDate >= period.fromLocalDate
    && occurrence.localDate <= period.toLocalDate).length;
  const targetOccurrences = definition?.minimumOccurrences ?? 0;
  return {
    nodeKey: link.nodeKey,
    entityKind: 'habit',
    entityId: link.entityId,
    completedOccurrences,
    targetOccurrences,
    completed: targetOccurrences > 0 && completedOccurrences >= targetOccurrences,
  };
}

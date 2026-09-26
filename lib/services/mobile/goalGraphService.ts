/**
 * "Show me how this goal actually happens" (#526, slice 1).
 *
 * The service between the route and the domain. It does three things and
 * refuses to do a fourth:
 *
 *  1. Resolves the goal id in the caller's own tree, through
 *     `readOwnedMemory`, which is the same ownership check the memory edit and
 *     delete paths use. A goal id from another account answers exactly as an
 *     id that never existed.
 *  2. Asks `generateGoalExecutionGraph` for the projection.
 *  3. Refuses to hand back a graph its own deterministic validation rejected.
 *
 * Reading a graph writes nothing. The proposals are recomputed from the goal's
 * own sentence on every request, because a proposal nobody accepted is worth
 * nothing the next morning; what is stored is the *decisions*, as
 * `goalGraphLinks`, and every graph handed out has them applied.
 *
 * ── The graph is rebuilt, so the client says which one ──────────
 *
 * Nothing persists the graph itself, so the server cannot know which reading
 * the user is looking at. Every call that needs one takes a `generation` and
 * rebuilds it. With the decomposition module on its deterministic path — which
 * is the shipped default — rebuilding reproduces exactly what `generate`
 * returned, so a confirm operates on the graph the user reviewed.
 *
 * With a model enabled the rebuild would differ, so the model's answer is the
 * one input that *is* kept (CL3): `generate` and `regenerate` ask the goal
 * planner model once per generation and store its validated steps in
 * `goalGraphProposals`; every other path — the execution read, `confirm` —
 * rebuilds from that stored answer and never calls a model. A selected node
 * the rebuilt graph still does not contain is refused as `unknown_node` and
 * creates nothing.
 */
import type {
  GoalConfirmationResult,
  GoalExecutionGraph,
  GoalGraphProgress,
  GoalLinkEntityKind,
  GoalNodeSelection,
  GoalProgressPeriod,
} from '../../../src/contracts/v1/goalGraphContracts';
import { applyLinksToGraph, confirmGoalGraphNodes } from '../../goalGraph/confirmGoalGraph';
import { deriveGoalGraphProgress } from '../../goalGraph/deriveProgress';
import {
  createStorageGoalNodeLinkStore,
  goalNodeLinkIdFor,
  type GoalNodeLinkStore,
} from '../../goalGraph/linkStore';
import { createHabitServices, type HabitServices } from '../habits/habitService';
import { loadDomainState } from './participantState';
import {
  GoalGraphGenerationError,
  generateGoalExecutionGraph,
} from '../../goalGraph/generateGoalGraph';
import type { DecompositionEngineDependencies } from '../../decomposition/engine';
import { MemoryNotFoundError, readOwnedMemory, type MemoryServiceOptions } from './memoryService';
import { GOAL_GRAPH_FIRST_GENERATION } from '../../../src/contracts/v1/goalGraphContracts';
import type { RuntimeMemoryRecord } from '../../../src/contracts/v1/memoryContracts';
import {
  GOAL_STEPS_PROMPT_VERSION,
  goalStepLanguageOf,
  type GoalStepDraft,
} from '../../goalGraph/goalStepPlan';
import {
  GOAL_STEP_PROPOSAL_SCHEMA_VERSION,
  createStorageGoalStepProposalStore,
  goalTextKeyFor,
  type GoalStepProposalStore,
} from '../../goalGraph/stepProposalStore';
import { createGoalStepModel, type GoalStepModel } from './goalStepModel';

export { GoalGraphGenerationError };

export interface GoalGraphServiceOptions extends MemoryServiceOptions {
  readonly engine?: DecompositionEngineDependencies;
  /** `rules` pins the deterministic path; the default is the engine's own. */
  readonly requestedEngine?: 'model' | 'rules';
  /** Which reading to build. Defaults to the first. */
  readonly generation?: number;
  readonly links?: GoalNodeLinkStore;
  readonly habits?: HabitServices;
  /**
   * The goal planner model. Consulted only by `generate` and `regenerate`,
   * and only when this generation has no stored answer. Defaults to the
   * consent-gated, metered model for this account.
   */
  readonly goalStepModel?: GoalStepModel;
  readonly proposals?: GoalStepProposalStore;
}

/** How far back a regeneration looks for steps it should not repeat. */
const PREVIOUS_GENERATIONS_CONSIDERED = 3;

/**
 * The planner model's steps for this goal at this generation, and why not
 * when there are none.
 *
 * `mayAsk` is the whole policy: only a request that is *for* a new reading —
 * `generate`, `regenerate` — may spend a model call. A read or a confirm that
 * finds nothing stored rebuilds from the sentence or the template, which is
 * exactly what `generate` answered in that case.
 */
async function plannedStepsFor(
  uid: string,
  goal: RuntimeMemoryRecord,
  generation: number,
  at: string,
  options: GoalGraphServiceOptions,
  mayAsk: boolean,
): Promise<{ steps: readonly GoalStepDraft[] | null; reason: string | null }> {
  // Anything the generator is about to refuse gets no model call first.
  if (goal.kind !== 'goal' || goal.status !== 'active' || typeof goal.content !== 'string'
    || goal.content.trim().length === 0 || !Number.isInteger(generation)
    || generation < GOAL_GRAPH_FIRST_GENERATION) {
    return { steps: null, reason: 'not_a_confirmed_goal' };
  }
  const store = options.proposals ?? createStorageGoalStepProposalStore(options.storage);
  const stored = await store.get(uid, goal.id, generation, goal.content);
  if (stored) return { steps: stored.steps, reason: null };
  if (!mayAsk) return { steps: null, reason: 'no_stored_model_steps' };

  const previousTitles: string[] = [];
  for (let back = generation - 1; back >= Math.max(GOAL_GRAPH_FIRST_GENERATION, generation - PREVIOUS_GENERATIONS_CONSIDERED); back -= 1) {
    const earlier = await store.get(uid, goal.id, back, goal.content);
    for (const step of earlier?.steps ?? []) previousTitles.push(step.title);
  }

  const model = options.goalStepModel ?? createGoalStepModel(uid);
  const outcome = await model({
    goalText: goal.content,
    language: goalStepLanguageOf(goal.content, goal.language),
    previousTitles,
  });
  if (outcome.steps.length === 0) return { steps: null, reason: outcome.reason ?? 'model_declined' };
  const kept = await store.putIfAbsent(uid, {
    schemaVersion: GOAL_STEP_PROPOSAL_SCHEMA_VERSION,
    goalMemoryId: goal.id,
    generation,
    goalTextKey: goalTextKeyFor(goal.content),
    steps: outcome.steps,
    promptVersion: GOAL_STEPS_PROMPT_VERSION,
    model: outcome.model,
    createdAt: at,
  });
  return { steps: kept.steps, reason: null };
}

/**
 * Thrown when this module builds a graph its own validator refuses.
 *
 * Distinct from `GoalGraphGenerationError`, which is a bad request — a
 * revoked goal, a memory that is not a goal. This one is a defect here, and
 * the route answers 500 rather than telling the user they did something wrong.
 */
export class GoalGraphInvalidError extends Error {
  constructor(readonly codes: readonly string[]) {
    super(`goal graph failed its own validation: ${codes.join(', ')}`);
    this.name = 'GoalGraphInvalidError';
  }
}

/**
 * The graph as this account holds it: proposals, with confirmed links applied.
 *
 * The link application is not cosmetic. Without it a user who confirmed two
 * nodes and reloaded would be offered the same two proposals again, with no
 * sign that the work already exists — and the screen would be inviting them to
 * create it twice. The claim in `confirmGoalGraphNodes` would refuse the
 * second press, so nothing would break; the user would just have been lied to.
 */
export async function readGoalExecutionGraph(
  uid: string,
  goalId: string,
  at: string,
  options: GoalGraphServiceOptions = {},
  mayAskModel = false,
): Promise<GoalExecutionGraph> {
  // Throws MemoryNotFoundError for another account's id, a revoked record, or
  // one that does not exist — all three answer 404, which is the only answer
  // that does not tell a stranger whether the id is real.
  const goal = await readOwnedMemory(uid, goalId, options);
  const generation = options.generation ?? GOAL_GRAPH_FIRST_GENERATION;
  const planned = await plannedStepsFor(uid, goal, generation, at, options, mayAskModel);
  const { graph, violations } = await generateGoalExecutionGraph({
    goal,
    generatedAt: at,
    generation: options.generation,
    requestedEngine: options.requestedEngine,
    plannedSteps: planned.steps,
    plannedStepsReason: planned.reason,
  }, options.engine ?? {});
  if (violations.length > 0) {
    throw new GoalGraphInvalidError(violations.map((violation) => violation.code));
  }
  const links = options.links ?? createStorageGoalNodeLinkStore(options.storage);
  return applyLinksToGraph(graph, await links.list(uid, goal.id));
}

/**
 * The graph and what the canonical entities say about it, in one read.
 *
 * `GET /api/mobile/goals/{goalId}/execution` is the only caller. The two
 * halves are deliberately separate functions — the graph is a projection of
 * the goal's own sentence, progress is a count of Commitments and Habit
 * occurrences — and this composes them without either learning about the
 * other: `deriveGoalGraphProgress` is handed the goal id the ownership check
 * already resolved, not the graph.
 *
 * That ordering is also the account-isolation guarantee. `readGoalExecutionGraph`
 * throws `MemoryNotFoundError` for an id outside the caller's tree before
 * anything derives anything, so progress is never counted for a goal the
 * caller cannot read.
 *
 * Both halves are built over the *same* storage adapter. Forwarding
 * `options.storage` is not a tidiness point: the graph half honours the seam
 * through `readGoalExecutionGraph`, so a caller that passed an adapter and was
 * ignored here would get its graph from that adapter and its progress from the
 * process-global one — every link missing, `confirmedCount: 0`, and no error
 * anywhere to say the two halves were reading different accounts.
 *
 * Reading writes nothing, on either half.
 */
export interface GoalExecutionState {
  readonly graph: GoalExecutionGraph;
  readonly progress: GoalExecutionProgress;
}

/**
 * Progress, plus the window it was counted over — `null` when nobody scoped one.
 *
 * The field exists because its absence was a lie a client could not detect. A
 * habit node read without a period reports `completedOccurrences: 0`, which is
 * byte-identical to the answer for somebody who has done nothing this week; a
 * goal screen opening on the cheap unscoped read would render "0 of 3" at a
 * user who had been to the gym three times. Echoing the period lets that
 * screen say "not scoped" instead, and it does so without making the period
 * required — a required period would push a clock and a timezone onto a route
 * that deliberately has neither.
 */
export interface GoalExecutionProgress extends GoalGraphProgress {
  readonly period: GoalProgressPeriod | null;
}

export async function readGoalExecutionState(
  uid: string,
  goalId: string,
  at: string,
  options: GoalGraphServiceOptions & { readonly period?: GoalProgressPeriod } = {},
): Promise<GoalExecutionState> {
  const graph = await readGoalExecutionGraph(uid, goalId, at, options);
  const storage = options.storage;
  const progress = await deriveGoalGraphProgress({
    scopeId: uid,
    // The graph's own id rather than the request's: `readOwnedMemory` resolved
    // it, so this is the record that was actually read.
    goalMemoryId: graph.goalMemoryId,
    ...(options.period ? { period: options.period } : {}),
    derivedAt: at,
  }, {
    links: options.links ?? createStorageGoalNodeLinkStore(storage),
    habits: options.habits ?? createHabitServices(storage),
    // `getParticipantStateSnapshot`, the default, reads the process-global
    // adapter and takes no seam of its own, so the adapter is bound here.
    ...(storage ? { readDomainState: (scopeId: string) => loadDomainState(storage, scopeId) } : {}),
  });
  return { graph, progress: { ...progress, period: options.period ?? null } };
}

/** The first reading of a goal. `generation` defaults to the first. */
export async function generateGoalGraph(
  uid: string,
  goalId: string,
  at: string,
  options: GoalGraphServiceOptions = {},
): Promise<GoalExecutionGraph> {
  return readGoalExecutionGraph(uid, goalId, at, options, true);
}

/**
 * A fresh reading, keeping everything the user already confirmed.
 *
 * `fromGeneration` is the reading they are looking at; the answer is the next
 * one. The links carry across because they are keyed on the node *key* rather
 * than the node id — `step.s1`, not `g1.step.s1` — which is the whole of
 * #526's "graph regeneration preserves already confirmed canonical links".
 *
 * Regenerating writes nothing. It is `generate` with a different number.
 */
export async function regenerateGoalGraph(
  uid: string,
  goalId: string,
  at: string,
  fromGeneration: number,
  options: GoalGraphServiceOptions = {},
): Promise<GoalExecutionGraph> {
  return readGoalExecutionGraph(uid, goalId, at, { ...options, generation: fromGeneration + 1 }, true);
}

/**
 * Materializes the nodes the user picked, through the existing boundaries.
 *
 * The graph is rebuilt at the generation the caller names and the selections
 * are resolved against it — see the header for why, and for what happens to a
 * selection the rebuild does not contain.
 */
export async function confirmGoalGraphSelections(
  uid: string,
  goalId: string,
  at: string,
  input: { readonly generation: number; readonly selections: readonly GoalNodeSelection[] },
  options: GoalGraphServiceOptions = {},
): Promise<GoalConfirmationResult> {
  const graph = await readGoalExecutionGraph(uid, goalId, at, {
    ...options,
    generation: input.generation,
  });
  return confirmGoalGraphNodes({
    graph,
    selections: input.selections,
    confirmedAt: at,
  }, {
    links: options.links ?? createStorageGoalNodeLinkStore(options.storage),
    ...(options.habits ? { habits: options.habits } : {}),
  });
}

/** What an unlink released, so the answer can say the work is still there. */
export interface GoalNodeUnlinkResult {
  readonly nodeId: string;
  readonly nodeKey: string;
  readonly entityKind: GoalLinkEntityKind;
  readonly entityId: string | null;
}

/**
 * Detaches a node from the canonical entity it produced, and stops there.
 *
 * #526: unlinking may not delete the Commitment or the Habit. This removes one
 * document from `goalGraphLinks` and has no import path to either — see
 * `linkStore`'s own header and the closure test that pins it. The answer names
 * the entity that was released precisely so a client can say "this is still in
 * your week" rather than leaving the user to guess.
 *
 * Null when this node has no link, which a route answers 404: an unlink of
 * something that was never linked did not happen.
 */
export async function unlinkGoalGraphNode(
  uid: string,
  goalId: string,
  nodeId: string,
  options: GoalGraphServiceOptions = {},
): Promise<GoalNodeUnlinkResult | null> {
  // Resolved through the same ownership check every other path uses, so an
  // unlink cannot reach into another account's links by naming their goal.
  const goal = await readOwnedMemory(uid, goalId, options);
  const links = options.links ?? createStorageGoalNodeLinkStore(options.storage);
  const linkId = goalNodeLinkIdFor(goal.id, nodeId);
  const existing = await links.get(uid, linkId);
  if (!existing) return null;
  await links.remove(uid, linkId);
  return {
    nodeId,
    nodeKey: existing.nodeKey,
    entityKind: existing.entityKind,
    entityId: existing.entityId,
  };
}

export { MemoryNotFoundError };

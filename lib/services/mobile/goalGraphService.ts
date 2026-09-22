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
 * With a model enabled the rebuild may differ, and the failure is safe rather
 * than silent: a selected node the rebuilt graph does not contain is refused
 * as `unknown_node` and creates nothing. Closing that gap is what persisting
 * the graph buys, and it is the follow-up this slice names.
 */
import type {
  GoalConfirmationResult,
  GoalExecutionGraph,
  GoalLinkEntityKind,
  GoalNodeSelection,
} from '../../../src/contracts/v1/goalGraphContracts';
import { applyLinksToGraph, confirmGoalGraphNodes } from '../../goalGraph/confirmGoalGraph';
import {
  createStorageGoalNodeLinkStore,
  goalNodeLinkIdFor,
  type GoalNodeLinkStore,
} from '../../goalGraph/linkStore';
import type { HabitServices } from '../habits/habitService';
import {
  GoalGraphGenerationError,
  generateGoalExecutionGraph,
} from '../../goalGraph/generateGoalGraph';
import type { DecompositionEngineDependencies } from '../../decomposition/engine';
import { MemoryNotFoundError, readOwnedMemory, type MemoryServiceOptions } from './memoryService';

export { GoalGraphGenerationError };

export interface GoalGraphServiceOptions extends MemoryServiceOptions {
  readonly engine?: DecompositionEngineDependencies;
  /** `rules` pins the deterministic path; the default is the engine's own. */
  readonly requestedEngine?: 'model' | 'rules';
  /** Which reading to build. Defaults to the first. */
  readonly generation?: number;
  readonly links?: GoalNodeLinkStore;
  readonly habits?: HabitServices;
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
): Promise<GoalExecutionGraph> {
  // Throws MemoryNotFoundError for another account's id, a revoked record, or
  // one that does not exist — all three answer 404, which is the only answer
  // that does not tell a stranger whether the id is real.
  const goal = await readOwnedMemory(uid, goalId, options);
  const { graph, violations } = await generateGoalExecutionGraph({
    goal,
    generatedAt: at,
    generation: options.generation,
    requestedEngine: options.requestedEngine,
  }, options.engine ?? {});
  if (violations.length > 0) {
    throw new GoalGraphInvalidError(violations.map((violation) => violation.code));
  }
  const links = options.links ?? createStorageGoalNodeLinkStore(options.storage);
  return applyLinksToGraph(graph, await links.list(uid, goal.id));
}

/** The first reading of a goal. `generation` defaults to the first. */
export async function generateGoalGraph(
  uid: string,
  goalId: string,
  at: string,
  options: GoalGraphServiceOptions = {},
): Promise<GoalExecutionGraph> {
  return readGoalExecutionGraph(uid, goalId, at, options);
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
  return readGoalExecutionGraph(uid, goalId, at, { ...options, generation: fromGeneration + 1 });
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

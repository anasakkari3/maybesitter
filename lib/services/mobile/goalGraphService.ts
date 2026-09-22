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
 * The fourth thing — writing anything — is absent, and that absence is two of
 * #526's acceptance criteria. Generating a graph creates no Commitment, no
 * Habit, no plan and no reminder, and in this slice it does not even store the
 * graph: it is a projection of the goal record and the engine's reading of it,
 * recomputed on request. Persistence arrives with the confirmation slice,
 * which has something durable to say — which nodes the user picked — and this
 * one does not.
 */
import type { GoalExecutionGraph } from '../../../src/contracts/v1/goalGraphContracts';
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

export async function generateGoalGraph(
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
    requestedEngine: options.requestedEngine,
  }, options.engine ?? {});
  if (violations.length > 0) {
    throw new GoalGraphInvalidError(violations.map((violation) => violation.code));
  }
  return graph;
}

export { MemoryNotFoundError };

/**
 * The goal execution graph (#526), slice 1: the model and generation.
 *
 * Slice 2 adds confirmation — materializing selected nodes through the
 * existing Commitment and Habit boundaries — and progress derived from the
 * canonical entities those produced.
 *
 * Still absent, and listed so the gap is visible rather than assumed:
 * regeneration that carries confirmed links forward (`applyLinksToGraph` is
 * the half of it that exists), persistence of the graph itself, and the
 * `GET /execution`, `POST /confirm`, `PATCH /nodes/{id}` and `/regenerate`
 * routes. Unlinking exists as `GoalNodeLinkStore.remove`, which removes the
 * link and cannot reach the canonical work; the route in front of it is
 * follow-up.
 *
 * Nothing here reaches `lib/planning/scheduler`. Per #526 a graph node never
 * goes to `schedulePlan`; only the Commitments and Habit occurrences a
 * confirmation materializes become planning demand.
 */
export {
  GoalGraphGenerationError,
  generateGoalExecutionGraph,
  type GenerateGoalGraphRequest,
  type GenerateGoalGraphResult,
} from './generateGoalGraph';
export {
  validateGoalExecutionGraph,
  type GoalGraphValidationOptions,
} from './validateGoalGraph';
export {
  checkpointNodeIdFor,
  decompositionProposalIdFor,
  edgeIdFor,
  goalGraphIdFor,
  milestoneNodeIdFor,
  stepNodeIdFor,
} from './ids';
export {
  GoalConfirmationError,
  applyLinksToGraph,
  confirmGoalGraphNodes,
  type ConfirmGoalGraphDependencies,
  type ConfirmGoalGraphRequest,
} from './confirmGoalGraph';
export {
  deriveGoalGraphProgress,
  type DeriveGoalProgressDependencies,
  type DeriveGoalProgressRequest,
} from './deriveProgress';
export {
  StorageGoalNodeLinkStore,
  createStorageGoalNodeLinkStore,
  goalNodeLinkIdFor,
  type ClaimGoalNodeLinkInput,
  type GoalNodeLinkStore,
} from './linkStore';

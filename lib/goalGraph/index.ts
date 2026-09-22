/**
 * The goal execution graph (#526), slice 1: the model and generation.
 *
 * Absent on purpose, and listed so the gap is visible rather than assumed:
 * confirmation (materializing selected nodes through the existing
 * Commitment/Habit boundaries), progress derivation from linked canonical
 * entities, regeneration that carries confirmed links forward, and the
 * `/confirm`, `/nodes/{id}` and `/regenerate` routes.
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

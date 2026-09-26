/**
 * Generating a goal's execution graph, and writing nothing while doing it
 * (#526, slice 1).
 *
 * ── What this function is ───────────────────────────────────────
 *
 * A pure projection. It takes the confirmed Goal record — a
 * `RuntimeMemoryRecord` of kind `goal`, which is where #168 and #202 already
 * put it and where this slice deliberately leaves it — asks the existing
 * decomposition engine to read the goal's own sentence, and arranges the
 * answer as nodes and edges. It returns the graph.
 *
 * It does not store the graph, create a Commitment, create a Habit, touch a
 * plan, or schedule anything. Two of #526's acceptance criteria are exactly
 * that claim — "existing stored Goal alone changes nothing in Daily Plan" and
 * "generate writes no Commitment/Habit" — and the way they are held is that
 * there is no writer in reach: the only collaborator is
 * `proposeDecomposition`, which is itself pure, and
 * `tests/goalGraph/goalGraphBoundaries.test.ts` asserts the import closure so
 * that a future convenience call cannot quietly add one.
 *
 * ── Why the decomposition engine, unchanged ─────────────────────
 *
 * #526 says in as many words not to build a goal-specific decomposition
 * engine, and the reason is visible in the field names below: everything a
 * step node carries is copied across, and nothing is re-read. The engine has
 * already checked each span against the source text and already refused
 * invented timings and owners, so a second reading here would be a second
 * opinion about the same sentence with no way to tell which one was right.
 *
 * The one seam worth naming is `commitmentId`. `DecompositionEngineInput`
 * calls its subject that because the engine was built for commitments; what
 * the field means is "the id of the thing being decomposed", and the engine
 * only ever copies it into the proposal it returns. Passing the goal memory id
 * is therefore correct and inert — the engine has no store and cannot write to
 * whatever the id names.
 *
 * ── Why generation emits no milestone ───────────────────────────
 *
 * A milestone is a stage, and neither the rules detector nor a step list has a
 * notion of one. The only way this function could emit "finish chapter two by
 * June" is by inventing both the stage and the date, which is the criterion it
 * exists to satisfy. So the graph is the steps the sentence actually contains,
 * plus one checkpoint standing for the goal being reached. Model-suggested
 * milestones are a later slice, and they arrive through the same deterministic
 * validation these nodes already pass.
 */

import {
  GOAL_GRAPH_CONTRACT_VERSION,
  GOAL_GRAPH_FIRST_GENERATION,
  GOAL_GRAPH_SCHEMA_VERSION,
  type GoalEdge,
  type GoalExecutionGraph,
  type GoalGraphLanguage,
  type GoalGraphProvenance,
  type GoalGraphViolation,
  type GoalNode,
  type GoalStepSource,
} from '../../src/contracts/v1/goalGraphContracts';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts';
import {
  proposeDecomposition,
  type DecompositionEngineDependencies,
} from '../decomposition/engine';
import {
  checkpointNodeIdFor,
  decompositionProposalIdFor,
  edgeIdFor,
  goalGraphIdFor,
  stepNodeIdFor,
} from './ids';
import { validateGoalExecutionGraph } from './validateGoalGraph';
import {
  GOAL_STEPS_MAX,
  GOAL_STEPS_MIN,
  goalStepKeyOf,
  goalStepLanguageOf,
  templateGoalSteps,
  type GoalStepDraft,
} from './goalStepPlan';

export class GoalGraphGenerationError extends Error {
  constructor(message: string) {
    super(`goal graph: ${message}`);
    this.name = 'GoalGraphGenerationError';
  }
}

export interface GenerateGoalGraphRequest {
  /** The confirmed Goal, as the memory store holds it. Read, never written. */
  readonly goal: RuntimeMemoryRecord;
  /** The caller's instant. There is no clock in this module. */
  readonly generatedAt: string;
  /** Defaults to the first generation; a regeneration passes the next number. */
  readonly generation?: number;
  /**
   * `rules` asks for the deterministic path outright. Defaults to `model`,
   * which falls back to rules when no provider is injected — the engine's own
   * behaviour, kept rather than second-guessed here.
   */
  readonly requestedEngine?: 'model' | 'rules';
  /**
   * Steps the goal planner model proposed for this generation, already
   * through `validateGoalStepDraft` (CL3). When there are at least
   * `GOAL_STEPS_MIN`, they are the graph's steps; otherwise the sentence split
   * or the template is. The caller fetched them — this function calls nothing.
   */
  readonly plannedSteps?: readonly GoalStepDraft[] | null;
  /** Why there are no planned steps, as a code, carried to provenance. */
  readonly plannedStepsReason?: string | null;
}

export interface GenerateGoalGraphResult {
  readonly graph: GoalExecutionGraph;
  /**
   * The deterministic validation #526 puts between generation and review.
   * Empty for every graph this function is able to build; non-empty is a
   * defect in this module, and the caller's cue not to offer the graph.
   */
  readonly violations: readonly GoalGraphViolation[];
}

/**
 * Refuses anything that is not a live confirmed goal belonging to this scope.
 *
 * A graph rooted in a revoked or superseded goal is a screen offering somebody
 * work they already withdrew, and a graph rooted in a `fact` or a `preference`
 * would be the product proposing commitments from an observation about the
 * person — which is the line #202 draws and the one #519 restates.
 */
function requireConfirmedGoal(goal: RuntimeMemoryRecord): void {
  if (!goal || typeof goal !== 'object') throw new GoalGraphGenerationError('no goal record');
  if (goal.kind !== 'goal') {
    throw new GoalGraphGenerationError(`memory ${goal.id} is a ${goal.kind}, not a goal`);
  }
  if (goal.status !== 'active') {
    throw new GoalGraphGenerationError(`goal ${goal.id} is ${goal.status}`);
  }
  if (typeof goal.content !== 'string' || goal.content.trim().length === 0) {
    throw new GoalGraphGenerationError(`goal ${goal.id} has no text to read`);
  }
}

export async function generateGoalExecutionGraph(
  request: GenerateGoalGraphRequest,
  dependencies: DecompositionEngineDependencies = {},
): Promise<GenerateGoalGraphResult> {
  const { goal } = request;
  requireConfirmedGoal(goal);
  const generation = request.generation ?? GOAL_GRAPH_FIRST_GENERATION;
  if (!Number.isInteger(generation) || generation < GOAL_GRAPH_FIRST_GENERATION) {
    throw new GoalGraphGenerationError(`generation must be an integer from ${GOAL_GRAPH_FIRST_GENERATION}`);
  }

  const scopeId = goal.scopeId;
  const goalText = goal.content;
  const graphId = goalGraphIdFor(scopeId, goal.id, generation);
  const proposalId = decompositionProposalIdFor(scopeId, goal.id, generation);

  const proposal = await proposeDecomposition({
    proposalId,
    // The engine's word for "the thing being decomposed"; see the header.
    commitmentId: goal.id,
    sourceText: goalText,
    requestedEngine: request.requestedEngine ?? 'model',
  }, dependencies);

  const checkpointId = checkpointNodeIdFor(generation);
  const nodes: GoalNode[] = [{
    nodeId: checkpointId,
    kind: 'checkpoint',
    status: 'proposed',
    title: goalText,
    // Always null. The goal record carries no date, so any value here would be
    // one this function made up, which is the failure the criterion names.
    statedTiming: null,
  }];
  const edges: GoalEdge[] = [];

  /**
   * A planner step as a node: inferred, because nothing in the sentence says
   * it, with no spans, and with the suggested kind and timing bucket carried
   * for the review screen. `statedTiming` stays null — no step here states a
   * time the goal's own words contain.
   */
  const pushPlanned = (steps: readonly GoalStepDraft[]): void => {
    for (const planned of steps) {
      const nodeId = stepNodeIdFor(generation, planned.stepId);
      nodes.push({
        nodeId,
        kind: 'decomposition_step_proposal',
        status: 'proposed',
        stepId: planned.stepId,
        title: planned.title,
        sourceSpans: [],
        inferred: true,
        statedTiming: null,
        statedOwner: null,
        suggestedAs: planned.suggestedAs,
        ...(planned.suggestedWhen ? { suggestedWhen: planned.suggestedWhen } : {}),
      });
      edges.push({
        edgeId: edgeIdFor('contributes_to', nodeId, checkpointId),
        kind: 'contributes_to',
        fromNodeId: nodeId,
        toNodeId: checkpointId,
      });
    }
  };

  const planned = request.plannedSteps && request.plannedSteps.length >= GOAL_STEPS_MIN
    ? request.plannedSteps
    : null;
  let stepSource: GoalStepSource;
  // The user's own clauses come first whenever the sentence splits (CL3
  // round 2, review M-1): "build the landing page, then set up payments" is
  // a plan the person already wrote, and a model may add to it, never replace
  // it. Only when the sentence does not split do the model's steps stand alone.
  if (proposal.outcome === 'decomposed') {
    stepSource = planned ? 'sentence_and_model' : 'sentence';
    for (const step of proposal.steps) {
      nodes.push({
        nodeId: stepNodeIdFor(generation, step.stepId),
        kind: 'decomposition_step_proposal',
        status: 'proposed',
        stepId: step.stepId,
        title: step.title,
        sourceSpans: step.sourceSpans,
        inferred: step.inferred,
        // Carried, not parsed. "by December" stays the words the user wrote.
        statedTiming: step.statedTiming,
        statedOwner: step.statedOwner,
      });
    }
    for (const step of proposal.steps) {
      const from = stepNodeIdFor(generation, step.stepId);
      edges.push({
        edgeId: edgeIdFor('contributes_to', from, checkpointId),
        kind: 'contributes_to',
        fromNodeId: from,
        toNodeId: checkpointId,
      });
      for (const dependency of step.dependsOn) {
        const to = stepNodeIdFor(generation, dependency.dependsOnStepId);
        edges.push({
          edgeId: edgeIdFor('depends_on', from, to),
          kind: 'depends_on',
          fromNodeId: from,
          toNodeId: to,
          dependencyKind: dependency.kind,
        });
      }
    }
    if (planned) {
      // A model step that restates a clause — the same words, or words one
      // of the clauses already contains — is the user's step, not a new one.
      const stated = proposal.steps.map((step) => ` ${goalStepKeyOf(step.title)} `);
      const restates = (title: string): boolean => {
        const key = ` ${goalStepKeyOf(title)} `;
        return stated.some((clause) => clause.includes(key) || key.includes(clause));
      };
      const room = Math.max(0, GOAL_STEPS_MAX - proposal.steps.length);
      pushPlanned(planned.filter((step) => !restates(step.title)).slice(0, room));
    }
  } else if (planned) {
    stepSource = 'model';
    pushPlanned(planned);
  } else {
    // The sentence does not split and no model step is available. A goal
    // with no step at all is a screen with nothing to press (first phone
    // run, shot 73), so it gets the deterministic start for its shape.
    stepSource = 'template';
    pushPlanned(templateGoalSteps(goalText, goalStepLanguageOf(goalText, goal.language)));
  }

  const provenance: GoalGraphProvenance = Object.freeze({
    decompositionProposalId: proposal.proposalId,
    decompositionOutcome: proposal.outcome,
    decomposition: proposal.provenance,
    atomicReason: proposal.outcome === 'atomic' ? proposal.reason : null,
    // The engine's findings, carried so an operator asking why a goal produced
    // one node has the answer without reading logs.
    violations: proposal.outcome === 'rejected' ? proposal.violations : Object.freeze([]),
    stepSource,
    stepSourceReason: planned ? null : request.plannedStepsReason ?? 'model_not_requested',
  });

  const graph: GoalExecutionGraph = Object.freeze({
    version: GOAL_GRAPH_CONTRACT_VERSION,
    schema: GOAL_GRAPH_SCHEMA_VERSION,
    graphId,
    goalMemoryId: goal.id,
    scopeId,
    language: goal.language as GoalGraphLanguage,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    generatedAt: request.generatedAt,
    generation,
    provenance,
  });

  return Object.freeze({
    graph,
    // Run here rather than left to the caller. #526 puts deterministic
    // validation between generation and review, and a validation the caller
    // has to remember to run is one the second caller will not.
    violations: validateGoalExecutionGraph(graph, { goalText, phase: 'generated' }),
  });
}

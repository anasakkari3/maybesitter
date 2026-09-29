/**
 * The deterministic gate between a proposal and a user (#526).
 *
 * Every graph in this file is hand-built and wrong on purpose. That is the
 * point: generation is arranged so that it cannot produce most of these, so a
 * validator exercised only through `generateGoalExecutionGraph` would have
 * whole branches nothing could reach — and the day a later slice hands it a
 * graph from a model or from storage, those branches would run for the first
 * time in production.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GOAL_GRAPH_CONTRACT_VERSION,
  GOAL_GRAPH_MAX_NODES,
  GOAL_GRAPH_SCHEMA_VERSION,
  type GoalEdge,
  type GoalExecutionGraph,
  type GoalGraphViolationCode,
  type GoalNode,
} from '../../src/contracts/v1/goalGraphContracts.ts';
import { validateGoalExecutionGraph } from '../../lib/goalGraph/validateGoalGraph.ts';
import { NOW, OWNER } from './goalGraphSupport.ts';

const GOAL_TEXT = 'Ship the app: write the docs by Friday, then announce it';

function graphOf(nodes: readonly GoalNode[], edges: readonly GoalEdge[] = []): GoalExecutionGraph {
  return {
    version: GOAL_GRAPH_CONTRACT_VERSION,
    schema: GOAL_GRAPH_SCHEMA_VERSION,
    graphId: 'graph-1',
    goalMemoryId: 'memory-1',
    scopeId: OWNER,
    language: 'en',
    nodes,
    edges,
    generatedAt: NOW,
    generation: 1,
    provenance: {
      decompositionProposalId: 'proposal-1',
      decompositionOutcome: 'decomposed',
      decomposition: { requestedEngine: 'rules', executedEngine: 'rules', fallbackUsed: false },
      atomicReason: null,
      violations: [],
      stepSource: 'sentence',
      stepSourceReason: 'model_not_requested',
    },
  };
}

const CHECKPOINT: GoalNode = {
  nodeId: 'g1.checkpoint.goal',
  kind: 'checkpoint',
  status: 'proposed',
  title: GOAL_TEXT,
  statedTiming: null,
};

function stepNode(stepId: string, overrides: Record<string, unknown> = {}): GoalNode {
  return {
    nodeId: `g1.step.${stepId}`,
    kind: 'decomposition_step_proposal',
    status: 'proposed',
    stepId,
    title: `do ${stepId}`,
    sourceSpans: [],
    inferred: true,
    statedTiming: null,
    statedOwner: null,
    ...overrides,
  } as GoalNode;
}

function contributes(fromNodeId: string, toNodeId: string): GoalEdge {
  return { edgeId: `e.contributes_to.${fromNodeId}.${toNodeId}`, kind: 'contributes_to', fromNodeId, toNodeId };
}

function dependsOn(fromNodeId: string, toNodeId: string): GoalEdge {
  return {
    edgeId: `e.depends_on.${fromNodeId}.${toNodeId}`,
    kind: 'depends_on',
    fromNodeId,
    toNodeId,
    dependencyKind: 'temporal',
  };
}

function codesFor(graph: GoalExecutionGraph, phase?: 'generated' | 'stored'): GoalGraphViolationCode[] {
  return validateGoalExecutionGraph(graph, { goalText: GOAL_TEXT, phase })
    .map((violation) => violation.code)
    .sort();
}

test('a well-formed graph produces no findings', () => {
  const graph = graphOf(
    [CHECKPOINT, stepNode('s1'), stepNode('s2')],
    [
      contributes('g1.step.s1', CHECKPOINT.nodeId),
      contributes('g1.step.s2', CHECKPOINT.nodeId),
      dependsOn('g1.step.s2', 'g1.step.s1'),
    ],
  );
  assert.deepEqual(codesFor(graph), []);
  assert.deepEqual(codesFor(graph, 'generated'), []);
});

test('a timing the goal text does not contain is INVENTED_TIMING, blank included', () => {
  const stated = graphOf(
    [CHECKPOINT, stepNode('s1', { statedTiming: 'by Friday' })],
    [contributes('g1.step.s1', CHECKPOINT.nodeId)],
  );
  assert.deepEqual(codesFor(stated), [], 'a verbatim timing is admissible');

  const invented = graphOf(
    [CHECKPOINT, stepNode('s1', { statedTiming: 'by 2026-11-30' })],
    [contributes('g1.step.s1', CHECKPOINT.nodeId)],
  );
  assert.deepEqual(codesFor(invented), ['INVENTED_TIMING']);

  // A blank claim is a claim about nothing, and `includes('')` is always true
  // — the case a plain verbatim check waves through.
  const blank = graphOf(
    [CHECKPOINT, stepNode('s1', { statedTiming: '   ' })],
    [contributes('g1.step.s1', CHECKPOINT.nodeId)],
  );
  assert.deepEqual(codesFor(blank), ['INVENTED_TIMING']);

  // A milestone is held to the same rule as a step, which is why the check is
  // per node rather than per step kind.
  const milestone = graphOf([
    CHECKPOINT,
    { nodeId: 'g1.milestone.m1', kind: 'milestone_proposal', status: 'proposed', title: 'Half way', statedTiming: 'by June' },
  ], [contributes('g1.milestone.m1', CHECKPOINT.nodeId)]);
  assert.deepEqual(codesFor(milestone), ['INVENTED_TIMING']);
});

test('duplicate ids, dangling edges and self edges are each named', () => {
  const duplicateNode = graphOf(
    [CHECKPOINT, stepNode('s1'), stepNode('s1')],
    [contributes('g1.step.s1', CHECKPOINT.nodeId)],
  );
  assert.deepEqual(codesFor(duplicateNode), ['DUPLICATE_NODE_ID']);

  const duplicateEdge = graphOf(
    [CHECKPOINT, stepNode('s1')],
    [contributes('g1.step.s1', CHECKPOINT.nodeId), contributes('g1.step.s1', CHECKPOINT.nodeId)],
  );
  assert.deepEqual(codesFor(duplicateEdge), ['DUPLICATE_EDGE_ID']);

  const dangling = graphOf(
    [CHECKPOINT, stepNode('s1')],
    [contributes('g1.step.s1', CHECKPOINT.nodeId), dependsOn('g1.step.s1', 'g1.step.ghost')],
  );
  assert.deepEqual(codesFor(dangling), ['UNKNOWN_EDGE_ENDPOINT']);

  const loop = graphOf(
    [CHECKPOINT, stepNode('s1')],
    [contributes('g1.step.s1', CHECKPOINT.nodeId), dependsOn('g1.step.s1', 'g1.step.s1')],
  );
  assert.deepEqual(codesFor(loop), ['SELF_EDGE']);
});

test('a dependency cycle is caught, and a diamond of contributions is not', () => {
  const cycle = graphOf(
    [CHECKPOINT, stepNode('s1'), stepNode('s2'), stepNode('s3')],
    [
      contributes('g1.step.s1', CHECKPOINT.nodeId),
      contributes('g1.step.s2', CHECKPOINT.nodeId),
      contributes('g1.step.s3', CHECKPOINT.nodeId),
      dependsOn('g1.step.s1', 'g1.step.s2'),
      dependsOn('g1.step.s2', 'g1.step.s3'),
      dependsOn('g1.step.s3', 'g1.step.s1'),
    ],
  );
  assert.deepEqual(codesFor(cycle), ['CYCLIC_DEPENDENCY']);

  // Three steps all contributing to one checkpoint is the ordinary shape, and
  // a cycle check that looked at every edge kind would call it a cycle.
  const diamond = graphOf(
    [CHECKPOINT, stepNode('s1'), stepNode('s2'), stepNode('s3')],
    [
      contributes('g1.step.s1', CHECKPOINT.nodeId),
      contributes('g1.step.s2', CHECKPOINT.nodeId),
      contributes('g1.step.s3', CHECKPOINT.nodeId),
    ],
  );
  assert.deepEqual(codesFor(diamond), []);
});

test('a node with no path to a checkpoint is unrooted, and so is a graph with none', () => {
  const orphan = graphOf([CHECKPOINT, stepNode('s1'), stepNode('s2')], [contributes('g1.step.s1', CHECKPOINT.nodeId)]);
  const findings = validateGoalExecutionGraph(orphan, { goalText: GOAL_TEXT });
  assert.deepEqual(findings.map((violation) => [violation.code, violation.subjectId]), [
    ['UNROOTED_NODE', 'g1.step.s2'],
  ]);

  // Reachability is transitive: a step feeding a milestone that feeds the
  // checkpoint is rooted, which a one-hop check would miss.
  const chained = graphOf([
    CHECKPOINT,
    { nodeId: 'g1.milestone.m1', kind: 'milestone_proposal', status: 'proposed', title: 'Half way', statedTiming: null },
    stepNode('s1'),
  ], [
    contributes('g1.milestone.m1', CHECKPOINT.nodeId),
    contributes('g1.step.s1', 'g1.milestone.m1'),
  ]);
  assert.deepEqual(codesFor(chained), []);

  const rootless = graphOf([stepNode('s1')], []);
  assert.deepEqual(codesFor(rootless), ['UNROOTED_NODE']);
});

test('a linked node is legitimate in a stored graph and refused in a generated one', () => {
  const linked = graphOf([
    CHECKPOINT,
    { nodeId: 'g1.commitment.c1', kind: 'linked_commitment', status: 'confirmed', commitmentId: 'commitment-1' },
    { nodeId: 'g1.habit.h1', kind: 'linked_habit', status: 'confirmed', habitId: 'habit-1' },
  ], [
    contributes('g1.commitment.c1', CHECKPOINT.nodeId),
    contributes('g1.habit.h1', CHECKPOINT.nodeId),
  ]);
  assert.deepEqual(codesFor(linked), [], 'a confirmed graph may hold links');
  assert.deepEqual(codesFor(linked, 'generated'), [
    'CANONICAL_LINK_IN_PROPOSAL',
    'CANONICAL_LINK_IN_PROPOSAL',
    'NOT_PROPOSED',
    'NOT_PROPOSED',
  ]);
});

test('a link with nothing to link to is MISSING_REFERENCE', () => {
  const empty = graphOf([
    CHECKPOINT,
    { nodeId: 'g1.commitment.c1', kind: 'linked_commitment', status: 'confirmed', commitmentId: '' },
    { nodeId: 'g1.habit.h1', kind: 'linked_habit', status: 'confirmed', habitId: '  ' },
  ], [
    contributes('g1.commitment.c1', CHECKPOINT.nodeId),
    contributes('g1.habit.h1', CHECKPOINT.nodeId),
  ]);
  assert.deepEqual(codesFor(empty), ['MISSING_REFERENCE', 'MISSING_REFERENCE']);
});

test('a blank title and an over-sized graph are both findings', () => {
  const blank = graphOf(
    [CHECKPOINT, stepNode('s1', { title: '  ' })],
    [contributes('g1.step.s1', CHECKPOINT.nodeId)],
  );
  assert.deepEqual(codesFor(blank), ['EMPTY_TITLE']);

  const many: GoalNode[] = [CHECKPOINT];
  const edges: GoalEdge[] = [];
  for (let index = 0; index < GOAL_GRAPH_MAX_NODES; index += 1) {
    many.push(stepNode(`s${index}`));
    edges.push(contributes(`g1.step.s${index}`, CHECKPOINT.nodeId));
  }
  assert.deepEqual(codesFor(graphOf(many, edges)), ['GRAPH_TOO_LARGE']);
});

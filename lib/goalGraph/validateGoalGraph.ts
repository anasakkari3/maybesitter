/**
 * Deterministic validation of a goal execution graph (#526).
 *
 * "Deterministic validation" sits between the model and the user in #526's
 * flow, and the word doing the work is *deterministic*: this function takes a
 * graph and the goal's own text, reads nothing else, calls nothing, and
 * returns the same findings every time. A validator that could ask a model
 * whether a milestone was reasonable would be a second opinion where the
 * pipeline needs a gate.
 *
 * ── The one rule that is not topology ───────────────────────────
 *
 * `INVENTED_TIMING` is the decomposition module's rule, called through
 * `statedValueAdmission`, not re-implemented here. That matters more than it
 * looks: the #526 acceptance criterion "no invented deadlines" and #26's
 * `INVENTED_TIMING` are the same requirement about the same two fields, and
 * two spellings of it would drift the day one of them was tightened.
 *
 * Everything else here is shape — duplicate ids, dangling edges, cycles,
 * orphans — which decomposition has no opinion about because its proposals are
 * flat step lists and this is a graph.
 *
 * ── Why a generated graph is checked harder ─────────────────────
 *
 * `phase: 'generated'` adds two findings a stored graph must not produce:
 * a node already claiming `confirmed`, and a `linked_commitment` or
 * `linked_habit`. Both are legitimate in a graph the user has since worked on
 * and impossible in one that was just generated, because generation writes no
 * canonical entity and confirms nothing. Splitting the phases is what lets the
 * same function serve the confirmation slice without weakening the check that
 * guards this one.
 */
import {
  GOAL_GRAPH_MAX_NODES,
  type GoalEdge,
  type GoalExecutionGraph,
  type GoalGraphViolation,
  type GoalGraphViolationCode,
  type GoalNode,
} from '../../src/contracts/v1/goalGraphContracts';
import { statedValueAdmission } from '../decomposition/engine/validator';

export interface GoalGraphValidationOptions {
  /**
   * The goal's own words, which `statedTiming` must occur verbatim inside.
   * Required rather than read off the graph: the graph deliberately does not
   * carry a copy of the goal text, and a validator that checked a value
   * against a copy travelling beside it would be checking nothing.
   */
  readonly goalText: string;
  /** `generated` adds the two findings only a fresh graph can commit. */
  readonly phase?: 'generated' | 'stored';
}

/** Titles are what a reviewer reads; a node kind that has none is exempt. */
function titleOf(node: GoalNode): string | null {
  return node.kind === 'milestone_proposal'
    || node.kind === 'decomposition_step_proposal'
    || node.kind === 'checkpoint'
    ? node.title
    : null;
}

function statedTimingOf(node: GoalNode): string | null {
  return node.kind === 'milestone_proposal'
    || node.kind === 'decomposition_step_proposal'
    || node.kind === 'checkpoint'
    ? node.statedTiming
    : null;
}

export function validateGoalExecutionGraph(
  graph: GoalExecutionGraph,
  options: GoalGraphValidationOptions,
): readonly GoalGraphViolation[] {
  const violations: GoalGraphViolation[] = [];
  const add = (code: GoalGraphViolationCode, subjectId: string | null, detail: string): void => {
    violations.push({ code, subjectId, detail });
  };
  const generated = (options.phase ?? 'stored') === 'generated';

  if (graph.nodes.length > GOAL_GRAPH_MAX_NODES) {
    add('GRAPH_TOO_LARGE', null, `graph holds ${graph.nodes.length} nodes, above ${GOAL_GRAPH_MAX_NODES}`);
  }

  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.nodeId)) {
      add('DUPLICATE_NODE_ID', node.nodeId, 'two nodes share this id');
    }
    nodeIds.add(node.nodeId);

    const title = titleOf(node);
    if (title !== null && title.trim().length === 0) {
      add('EMPTY_TITLE', node.nodeId, 'node title is blank');
    }

    // The same rule the decomposition validator applies to a step, applied to
    // a node. Not a copy of it — the same function.
    const timing = statedTimingOf(node);
    if (statedValueAdmission(options.goalText, timing) !== null) {
      add(
        'INVENTED_TIMING',
        node.nodeId,
        'statedTiming is blank or does not occur verbatim in the goal text',
      );
    }

    if (node.kind === 'linked_commitment' && node.commitmentId.trim().length === 0) {
      add('MISSING_REFERENCE', node.nodeId, 'linked_commitment carries no commitmentId');
    }
    if (node.kind === 'linked_habit' && node.habitId.trim().length === 0) {
      add('MISSING_REFERENCE', node.nodeId, 'linked_habit carries no habitId');
    }

    if (generated) {
      if (node.kind === 'linked_commitment' || node.kind === 'linked_habit') {
        add(
          'CANONICAL_LINK_IN_PROPOSAL',
          node.nodeId,
          `generation created no canonical entity, so a ${node.kind} here means something wrote one`,
        );
      }
      if (node.status !== 'proposed') {
        add('NOT_PROPOSED', node.nodeId, `a generated node is ${node.status}, which only the user can make it`);
      }
    }
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.edgeId)) {
      add('DUPLICATE_EDGE_ID', edge.edgeId, 'two edges share this id');
    }
    edgeIds.add(edge.edgeId);
    if (edge.fromNodeId === edge.toNodeId) {
      add('SELF_EDGE', edge.edgeId, 'edge points at its own node');
      continue;
    }
    for (const endpoint of [edge.fromNodeId, edge.toNodeId]) {
      if (!nodeIds.has(endpoint)) {
        add('UNKNOWN_EDGE_ENDPOINT', edge.edgeId, `edge names ${endpoint}, which is not a node here`);
      }
    }
  }

  if (hasCycle(graph.edges.filter((edge) => edge.kind === 'depends_on'), nodeIds)) {
    add('CYCLIC_DEPENDENCY', null, 'the depends_on edges do not form a DAG');
  }

  for (const nodeId of unrootedNodes(graph)) {
    add('UNROOTED_NODE', nodeId, 'no contributes_to path from this node reaches a checkpoint');
  }

  return Object.freeze(violations);
}

/**
 * Kahn's algorithm over the ordering edges only.
 *
 * `contributes_to` is excluded on purpose: it is containment, and a diamond of
 * two steps both contributing to one checkpoint is the normal shape, not a
 * cycle. Only `depends_on` claims an order that could contradict itself.
 *
 * A self edge is skipped rather than reported, because `SELF_EDGE` has already
 * named it. Same precedence as the decomposition validator's `SELF_DEPENDENCY`
 * over `CYCLIC_DEPENDENCY`, and for the same reason: one defect earns one
 * code, or a caller handed two findings for one edge cannot tell whether it
 * has one problem or two.
 */
function hasCycle(edges: readonly GoalEdge[], nodeIds: ReadonlySet<string>): boolean {
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  nodeIds.forEach((nodeId) => indegree.set(nodeId, 0));
  for (const edge of edges) {
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) continue;
    if (edge.fromNodeId === edge.toNodeId) continue;
    const list = outgoing.get(edge.fromNodeId) ?? [];
    list.push(edge.toNodeId);
    outgoing.set(edge.fromNodeId, list);
    indegree.set(edge.toNodeId, (indegree.get(edge.toNodeId) ?? 0) + 1);
  }
  const ready: string[] = [];
  indegree.forEach((degree, nodeId) => { if (degree === 0) ready.push(nodeId); });
  let settled = 0;
  while (ready.length > 0) {
    const nodeId = ready.pop() as string;
    settled += 1;
    for (const next of outgoing.get(nodeId) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  return settled !== indegree.size;
}

/**
 * Nodes with no `contributes_to` path to a checkpoint, ascending.
 *
 * A proposal that advances nothing is not a smaller proposal, it is one the
 * review screen has nowhere to put — and a graph whose edges were built wrong
 * looks exactly like a correct graph until somebody asks what a node is *for*.
 */
function unrootedNodes(graph: GoalExecutionGraph): readonly string[] {
  const checkpoints = graph.nodes
    .filter((node) => node.kind === 'checkpoint')
    .map((node) => node.nodeId);
  if (checkpoints.length === 0) {
    // No checkpoint at all is reported once, against every other node, rather
    // than silently passing because the search has nowhere to reach.
    return graph.nodes.map((node) => node.nodeId).sort();
  }
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'contributes_to') continue;
    const list = incoming.get(edge.toNodeId) ?? [];
    list.push(edge.fromNodeId);
    incoming.set(edge.toNodeId, list);
  }
  const reached = new Set<string>(checkpoints);
  const queue = [...checkpoints];
  while (queue.length > 0) {
    const nodeId = queue.pop() as string;
    for (const source of incoming.get(nodeId) ?? []) {
      if (reached.has(source)) continue;
      reached.add(source);
      queue.push(source);
    }
  }
  return graph.nodes
    .filter((node) => !reached.has(node.nodeId))
    .map((node) => node.nodeId)
    .sort();
}

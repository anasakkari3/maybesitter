/**
 * Turning the nodes a user picked into real work (#526, slice 2).
 *
 * ── This is the arrow slice 1 refused to draw ───────────────────
 *
 * Generation is read-only, and `tests/goalGraph/goalGraphIsolation.test.ts`
 * proves it by comparing the whole account tree before and after. This module
 * is the only place in the goal-graph feature that writes anything canonical,
 * and it writes through the boundaries that already exist:
 *
 *  - a Commitment through `mapExtractionToCommand` → `applyParticipantCommands`
 *    → `ConfirmCommitment`, which is the sequence `promoteSeed` uses to turn a
 *    confirmed sentence into a commitment, and the sequence the capture
 *    confirm uses. There is no third way to create one and this module does
 *    not add one.
 *  - a Habit through `createHabitWithOccurrences`, after
 *    `parseHabitDefinitionInput` — the real habit contract's own validator
 *    (#520), so a habit born from a goal is held to exactly the bounds a habit
 *    typed by hand is, and is materialized into real dates the same way.
 *
 * Nothing here reaches `schedulePlan`. A graph node never becomes planning
 * demand; the Commitment and the Habit occurrences it produces do, through the
 * paths that already carry them.
 *
 * ── Confirming twice creates one thing ──────────────────────────
 *
 * The order is claim, create, settle — `promoteSeed`'s order, for its reason.
 * The claim is a transaction on a document id derived from the node id, so the
 * second press finds the first link and this function creates nothing at all.
 * The window that remains is the same one `promoteSeed` has: a process that
 * dies between creating the entity and settling the link leaves a `pending`
 * link, and the next confirm completes it rather than creating a twin —
 * `resume` below, which is why `pending` is a state and not a boolean.
 *
 * ── A cadence is never inferred ─────────────────────────────────
 *
 * `as: 'habit'` must carry the habit's own fields. A goal sentence does not
 * say how many times a week, and a default here would be the product deciding
 * how often somebody goes to the gym — the thing #520's contract exists to
 * prevent and the thing this module is best placed to do by accident.
 */

import {
  CONFIRMABLE_GOAL_NODE_KINDS,
  type GoalConfirmationRefusal,
  type GoalConfirmationResult,
  type GoalEdge,
  type GoalExecutionGraph,
  type GoalNode,
  type GoalNodeLink,
  type GoalNodeSelection,
} from '../../src/contracts/v1/goalGraphContracts';
import type { Command } from '../../src/domain/stateMachine';
import { mapExtractionToCommand } from '../../src/extraction/mapExtractionToCommand';
import type { ExtractionResult } from '../../src/extraction/extractionTypes';
import {
  applyParticipantCommand,
  applyParticipantCommands,
} from '../services/mobile/participantState';
import { HabitValidationError, parseHabitDefinitionInput } from '../../src/contracts/v1/habitContracts';
import {
  createHabitServices,
  createHabitWithOccurrences,
  todayLocalDateFor,
  type HabitServices,
} from '../services/habits/habitService';
import {
  createStorageGoalNodeLinkStore,
  goalNodeLinkIdFor,
  type GoalNodeLinkStore,
} from './linkStore';
import { edgeIdFor, goalNodeKeyOf, nodeIdFor } from './ids';

export class GoalConfirmationError extends Error {
  constructor(message: string) {
    super(`goal confirmation: ${message}`);
    this.name = 'GoalConfirmationError';
  }
}

export interface ConfirmGoalGraphRequest {
  readonly graph: GoalExecutionGraph;
  readonly selections: readonly GoalNodeSelection[];
  /** The instant the user pressed confirm. No clock is read here. */
  readonly confirmedAt: string;
}

export interface ConfirmGoalGraphDependencies {
  readonly links?: GoalNodeLinkStore;
  readonly habits?: HabitServices;
}

/**
 * The commitment a confirmed node becomes, in the shape the mapper takes.
 *
 * Deliberately the same construction `promoteSeed` uses for a seed, down to
 * the nulls: no time, no person, no reminder. The node's title is a fragment
 * of a goal somebody wrote, not an appointment — inventing a due date for it
 * here would be the "no invented deadlines" criterion failing one slice after
 * generation was built to hold it.
 *
 * `statedTiming` is *not* copied into `dueAt`. It is the source's own words
 * and unresolved; resolving it against a clock is Capture's job, and this
 * module has no clock to resolve it against by design.
 */
function confirmedNodeCommitment(title: string): ExtractionResult {
  return {
    type: 'task',
    action: title,
    title,
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 1, type: 1, action: 1, time: 1, priority: 1 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: false,
    explicitPressureRequest: false,
    rawText: title,
    parserVersion: 'goal-node-confirmation-v1',
  };
}

function commitmentIdOf(commands: readonly Command[]): string | null {
  const draft = commands.find((command): command is Extract<Command, { type: 'CreateDraft' }> =>
    command.type === 'CreateDraft');
  return draft?.commitment.id ?? null;
}

/** The label a node offers a commitment. Only proposal kinds have one. */
function titleOf(node: GoalNode): string | null {
  return node.kind === 'milestone_proposal' || node.kind === 'decomposition_step_proposal'
    ? node.title
    : null;
}

export async function confirmGoalGraphNodes(
  request: ConfirmGoalGraphRequest,
  dependencies: ConfirmGoalGraphDependencies = {},
): Promise<GoalConfirmationResult> {
  const { graph, confirmedAt } = request;
  if (typeof confirmedAt !== 'string' || Number.isNaN(Date.parse(confirmedAt))) {
    throw new GoalConfirmationError('confirmedAt must be an ISO-8601 instant');
  }
  const links = dependencies.links ?? createStorageGoalNodeLinkStore();
  const habits = dependencies.habits ?? createHabitServices();
  const byId = new Map(graph.nodes.map((node) => [node.nodeId, node]));

  const created: GoalNodeLink[] = [];
  const replayed: GoalNodeLink[] = [];
  const refused: GoalConfirmationRefusal[] = [];

  // Deduplicated, because one request naming a node twice is the same double
  // press as two requests — and the claim below would answer the second one
  // `replayed`, which would report a replay that never happened.
  const seen = new Set<string>();
  for (const selection of request.selections) {
    if (seen.has(selection.nodeId)) continue;
    seen.add(selection.nodeId);

    // Asked before anything else, including before the node's kind is
    // examined. A graph handed out by the read path already has confirmed
    // nodes replaced by `linked_commitment` and `linked_habit`, which are not
    // confirmable kinds — so checking the kind first would answer a retried
    // request with `node_not_confirmable` instead of the decision it is
    // retrying. A client resending after a dropped connection must get the
    // first answer back, not a refusal that reads like it did something wrong.
    const alreadyLinked = await links.get(
      graph.scopeId,
      goalNodeLinkIdFor(graph.goalMemoryId, selection.nodeId),
    );
    if (alreadyLinked && alreadyLinked.state === 'linked') {
      replayed.push(alreadyLinked);
      continue;
    }

    const node = byId.get(selection.nodeId);
    if (!node) {
      refused.push({
        nodeId: selection.nodeId,
        nodeKey: goalNodeKeyOf(selection.nodeId),
        code: 'unknown_node',
        detail: 'no such node in this graph',
      });
      continue;
    }
    if (!CONFIRMABLE_GOAL_NODE_KINDS.includes(node.kind)) {
      refused.push({
        nodeId: selection.nodeId,
        nodeKey: goalNodeKeyOf(selection.nodeId),
        code: 'node_not_confirmable',
        detail: `a ${node.kind} is not something to create`,
      });
      continue;
    }
    const title = titleOf(node);
    if (title === null) {
      refused.push({
        nodeId: selection.nodeId,
        nodeKey: goalNodeKeyOf(selection.nodeId),
        code: 'node_not_confirmable',
        detail: 'node has no title',
      });
      continue;
    }

    // The habit input is validated *before* the claim, so a rejected body
    // leaves no `pending` link behind for the next confirm to resume.
    let habitInput: ReturnType<typeof parseHabitDefinitionInput> | null = null;
    if (selection.as === 'habit') {
      try {
        habitInput = parseHabitDefinitionInput({
          title,
          ...selection.habit,
          // Not the caller's to state — see the header, and #520's own rule
          // that only the verified identity may set the scope.
          scopeId: graph.scopeId,
          // Not the caller's to state either. A habit that reached the store
          // claiming `user_created` would be indistinguishable, a week later,
          // from one somebody typed — and this one came out of a goal.
          source: 'goal_confirmed',
          confirmation: {
            confirmedByUserAt: confirmedAt,
            sourceRef: graph.goalMemoryId,
            acceptedSuggestedValues: true,
          },
        });
      } catch (error) {
        refused.push({
          nodeId: selection.nodeId,
          nodeKey: goalNodeKeyOf(selection.nodeId),
          code: 'habit_input_invalid',
          detail: error instanceof HabitValidationError ? error.message : 'invalid habit',
        });
        continue;
      }
    }

    const claim = await links.claim({
      scopeId: graph.scopeId,
      goalMemoryId: graph.goalMemoryId,
      nodeId: node.nodeId,
      generation: graph.generation,
      entityKind: selection.as,
      confirmedByUserAt: confirmedAt,
    }, confirmedAt);

    if (claim.replayed && claim.link.state === 'linked') {
      // Already done. The answer is the link that happened, not a second one.
      replayed.push(claim.link);
      continue;
    }
    // Either a fresh claim, or a `pending` one a previous attempt abandoned
    // between creating nothing and settling. Both are completed the same way.
    const linkId = goalNodeLinkIdFor(graph.goalMemoryId, node.nodeId);
    let entityId: string;
    try {
      entityId = selection.as === 'habit'
        ? (await createHabitWithOccurrences(
          habits,
          habitInput!,
          confirmedAt,
          todayLocalDateFor(confirmedAt),
        )).habit.habitId
        : await createCommitment(graph.scopeId, title, confirmedAt);
    } catch (error) {
      // The claim goes, so the button works again. A node stuck `pending` with
      // nothing behind it is a dead end the user cannot clear.
      await links.release(graph.scopeId, linkId).catch(() => undefined);
      throw error;
    }
    const settled = await links.settle(graph.scopeId, linkId, entityId, confirmedAt);
    if (!settled) throw new GoalConfirmationError(`link ${linkId} vanished while creating ${entityId}`);
    (claim.replayed ? replayed : created).push(settled);
  }

  return Object.freeze({
    graph: applyLinksToGraph(graph, await links.list(graph.scopeId, graph.goalMemoryId)),
    created: Object.freeze(created),
    replayed: Object.freeze(replayed),
    refused: Object.freeze(refused),
  });
}

/**
 * The commitment creation seam, and the only one this repo has.
 *
 * `mapExtractionToCommand` mints the id and is pure; `applyParticipantCommands`
 * writes the draft; `ConfirmCommitment` activates it — the same activation the
 * capture confirm performs, because the user confirmed this one by pressing
 * the button. A draft nobody confirmed is not a commitment and would sit in
 * the account invisible to every list.
 */
async function createCommitment(scopeId: string, title: string, at: string): Promise<string> {
  const commands = mapExtractionToCommand(confirmedNodeCommitment(title), at);
  const commitmentId = commitmentIdOf(commands);
  if (!commitmentId) throw new GoalConfirmationError(`node title produced no commitment: ${title}`);
  await applyParticipantCommands(scopeId, commands);
  await applyParticipantCommand(scopeId, { type: 'ConfirmCommitment', commitmentId, now: at });
  return commitmentId;
}

/**
 * Replaces every linked node in place, keeping its `nodeId`.
 *
 * Keeping the id is what keeps the edges valid: a `contributes_to` edge named
 * the proposal, and after confirmation it names the link, which is the same
 * place in the graph. Losing the title is deliberate — #526 says not to
 * duplicate canonical state in a node, and after confirmation the title lives
 * on the Commitment, where the user can edit it and have the edit mean
 * something.
 *
 * Matching is by node key rather than node id, which is what carries confirmed
 * links across a regeneration: generation 2 mints `g2.step.s1` where the user
 * confirmed `g1.step.s1`, and both are the key `step.s1`.
 *
 * A link whose node this reading does not contain is appended rather than
 * dropped (CL3). With the sentence split that never happened — the same
 * sentence gives the same keys — but a goal planner model's second reading
 * proposes different steps, and a graph that silently lost the work the user
 * already confirmed would be the regeneration criterion failing in the other
 * direction. The appended node contributes to the checkpoint like any step.
 *
 * Exported because the read path applies it to every graph it hands out, and a
 * second implementation would be a second answer to "what does a confirmed
 * graph look like".
 */
export function applyLinksToGraph(
  graph: GoalExecutionGraph,
  links: readonly GoalNodeLink[],
): GoalExecutionGraph {
  const byNodeKey = new Map(links
    .filter((link) => link.state === 'linked' && link.entityId !== null)
    .map((link) => [link.nodeKey, link]));
  if (byNodeKey.size === 0) return graph;
  const linkedNode = (nodeId: string, link: GoalNodeLink): GoalNode => (link.entityKind === 'habit'
    ? { nodeId, kind: 'linked_habit', status: 'confirmed', habitId: link.entityId as string }
    : { nodeId, kind: 'linked_commitment', status: 'confirmed', commitmentId: link.entityId as string });

  const present = new Set(graph.nodes.map((node) => goalNodeKeyOf(node.nodeId)));
  const nodes = graph.nodes.map((node): GoalNode => {
    // Matched on the key, so a graph regenerated at generation 2 still finds
    // the link a user confirmed against generation 1 — which is #526's
    // "regeneration preserves already confirmed canonical links".
    const link = byNodeKey.get(goalNodeKeyOf(node.nodeId));
    return link ? linkedNode(node.nodeId, link) : node;
  });
  const edges: GoalEdge[] = [...graph.edges];
  const checkpoint = graph.nodes.find((node) => node.kind === 'checkpoint');
  for (const link of Array.from(byNodeKey.values())) {
    if (present.has(link.nodeKey) || !checkpoint) continue;
    const nodeId = nodeIdFor(graph.generation, link.nodeKey);
    nodes.push(linkedNode(nodeId, link));
    edges.push({
      edgeId: edgeIdFor('contributes_to', nodeId, checkpoint.nodeId),
      kind: 'contributes_to',
      fromNodeId: nodeId,
      toNodeId: checkpoint.nodeId,
    });
  }
  return Object.freeze({
    ...graph,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
  });
}

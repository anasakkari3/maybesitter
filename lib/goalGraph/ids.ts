/**
 * Every id in a goal execution graph, derived (#526).
 *
 * No uuid and no timestamp anywhere. The same goal, at the same generation,
 * through the same engine, must produce the same graph byte for byte —
 * otherwise "deterministic validation" is a claim about a function whose
 * output nobody can compare to anything, and a regeneration could not be
 * diffed against the generation the user is looking at.
 *
 * `graphId` hashes the scope in with the goal, so two accounts that somehow
 * held the same memory id would still not collide, and it goes through
 * `docIdForKey` because the follow-up slice stores these and a document id is
 * what it will need. Node ids stay readable — `g1.step.s2` — because they are
 * what an operator reads in a violation, and a page of sha256 would make every
 * finding say the same thing.
 */
import { docIdForKey } from '../storage/paths';

export function goalGraphIdFor(scopeId: string, goalMemoryId: string, generation: number): string {
  return docIdForKey(`goal-graph:${scopeId}:${goalMemoryId}:${generation}`);
}

/**
 * A node's identity, without the generation it happened to be minted in.
 *
 * This is the part that means "the second step of this goal" rather than "the
 * second step of this goal, as read on Tuesday". Regeneration mints new node
 * ids — `g2.step.s1` where there was `g1.step.s1` — and two things have to
 * survive that: the link a user already confirmed must still attach to the
 * node it belongs to, and confirming that node again must not create a second
 * Commitment for it.
 *
 * Both are `GoalNodeLink.nodeKey`, which is this. Keying the link on the raw
 * node id instead makes the graph's own acceptance criterion — "regeneration
 * preserves already confirmed canonical links" — false, and quietly puts a
 * second gym session in somebody's week the first time they press regenerate
 * and then confirm.
 *
 * A key is stable only while the *step* is. The rules detector numbers steps
 * positionally (`s1`, `s2`), so an edited goal sentence can move `s1` onto a
 * different clause — and then the link should not carry over, which is what
 * editing the goal means. That is a property of the decomposition, not
 * something this module can paper over.
 */
export type GoalNodeKey = string;

/** The single sink node: the goal itself, reached. */
export const CHECKPOINT_NODE_KEY: GoalNodeKey = 'checkpoint.goal';

export function stepNodeKeyFor(stepId: string): GoalNodeKey {
  return `step.${stepId}`;
}

export function milestoneNodeKeyFor(milestoneKey: string): GoalNodeKey {
  return `milestone.${milestoneKey}`;
}

/** `g{generation}.{key}`. The one place a generation enters a node id. */
export function nodeIdFor(generation: number, nodeKey: GoalNodeKey): string {
  return `g${generation}.${nodeKey}`;
}

/**
 * The inverse of `nodeIdFor`.
 *
 * A node id this module did not mint has no generation prefix to strip, and is
 * its own key — so an id from somewhere else is carried through rather than
 * silently truncated into a key that collides with a real one.
 */
export function goalNodeKeyOf(nodeId: string): GoalNodeKey {
  const match = /^g\d+\.(.+)$/.exec(nodeId);
  return match ? match[1] : nodeId;
}

export function checkpointNodeIdFor(generation: number): string {
  return nodeIdFor(generation, CHECKPOINT_NODE_KEY);
}

export function stepNodeIdFor(generation: number, stepId: string): string {
  return nodeIdFor(generation, stepNodeKeyFor(stepId));
}

export function milestoneNodeIdFor(generation: number, milestoneKey: string): string {
  return nodeIdFor(generation, milestoneNodeKeyFor(milestoneKey));
}

/**
 * Unique within one graph and stable across runs, which is all an edge id has
 * to be — edges are not addressed from outside the graph, so this is a label
 * rather than a key.
 */
export function edgeIdFor(kind: string, fromNodeId: string, toNodeId: string): string {
  return `e.${kind}.${fromNodeId}.${toNodeId}`;
}

/**
 * The decomposition run's own id.
 *
 * Derived from the same three things as the graph id, so a rerun of generation
 * is the same decomposition attempt rather than a new one with a new id — which
 * is what makes two runs comparable at all.
 */
export function decompositionProposalIdFor(
  scopeId: string,
  goalMemoryId: string,
  generation: number,
): string {
  return docIdForKey(`goal-graph-decomposition:${scopeId}:${goalMemoryId}:${generation}`);
}

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

/** The single sink node: the goal itself, reached. */
export function checkpointNodeIdFor(generation: number): string {
  return `g${generation}.checkpoint.goal`;
}

export function stepNodeIdFor(generation: number, stepId: string): string {
  return `g${generation}.step.${stepId}`;
}

export function milestoneNodeIdFor(generation: number, milestoneKey: string): string {
  return `g${generation}.milestone.${milestoneKey}`;
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

/**
 * What a client may send to the execution-graph routes (#526, slice 3).
 *
 * The parsing sits here rather than in the route handlers for the reason
 * `lib/services/habits/habitApi.ts` does: three routes share a goal id, a
 * generation and a node id, and three hand-rolled readings of those would
 * drift — the first one to accept a node id with a slash in it would be
 * building a document path out of it.
 *
 * Everything below rejects rather than coerces. A selection this module
 * quietly dropped would be a node the user ticked and no commitment created,
 * with a 200 saying it worked.
 */
import {
  GOAL_GRAPH_FIRST_GENERATION,
  type GoalNodeSelection,
} from '../../src/contracts/v1/goalGraphContracts';

/**
 * A sanity bound on the generation a client may ask for.
 *
 * The number only feeds `docIdForKey` and the `g{n}.` prefix, so a huge one is
 * not dangerous — it is just an id nobody can read and a graph nobody asked
 * for. Refusing it keeps the node ids in the answer the shape every other part
 * of this feature assumes.
 */
export const GOAL_GRAPH_MAX_GENERATION = 1000;

/** The node ids this feature mints: `g{n}.{kind}.{key}`, or a bare key. */
const NODE_ID = /^(?:g\d{1,4}\.)?[a-z_]+\.[A-Za-z0-9_-]{1,64}$/;

export class GoalGraphRequestError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'GoalGraphRequestError';
  }
}

export function goalGraphRequestResponse(error: GoalGraphRequestError): Response {
  return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The generation a client says it is holding.
 *
 * Required to be stated rather than defaulted from a counter, because there is
 * no counter: slice 3 does not persist the graph, so the server cannot know
 * which reading the user is looking at unless they say. Absent means the
 * first, which is what a client that has only ever called `generate` holds.
 */
export function parseGeneration(value: unknown, field = 'generation'): number {
  if (value === undefined || value === null) return GOAL_GRAPH_FIRST_GENERATION;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new GoalGraphRequestError(`${field} must be an integer`, 'invalid_generation');
  }
  if (value < GOAL_GRAPH_FIRST_GENERATION || value > GOAL_GRAPH_MAX_GENERATION) {
    throw new GoalGraphRequestError(
      `${field} must be between ${GOAL_GRAPH_FIRST_GENERATION} and ${GOAL_GRAPH_MAX_GENERATION}`,
      'invalid_generation',
    );
  }
  return value;
}

/**
 * A node id from a URL segment or a body field.
 *
 * Checked in full against the shape this feature mints, not loosely, because
 * the value reaches `docIdForKey` and — through `goalNodeKeyOf` — a document
 * id. A segment carrying a slash or a traversal must not survive this
 * function, and the shape is known, so there is no reason to accept anything
 * wider.
 */
export function parseNodeId(value: unknown): string {
  if (typeof value !== 'string' || !NODE_ID.test(value)) {
    throw new GoalGraphRequestError('not a node id', 'invalid_node_id');
  }
  return value;
}

/** The maximum number of nodes one confirm may name. A graph holds 64. */
export const MAX_SELECTIONS_PER_CONFIRM = 64;

/**
 * The nodes the user ticked, and what they ticked them to be.
 *
 * `as: 'habit'` must carry a `habit` object. It is passed through untouched to
 * `parseHabitDefinitionInput`, which is the habit contract's own validator —
 * this module does not second-guess a cadence, and it does not supply one
 * either: #520's rule is that a habit's cadence and duration are things the
 * person stated, and a default invented at the API edge would be the product
 * deciding how often somebody goes to the gym.
 */
export function parseSelections(value: unknown): readonly GoalNodeSelection[] {
  if (!Array.isArray(value)) {
    throw new GoalGraphRequestError('selections must be an array', 'invalid_selections');
  }
  if (value.length === 0) {
    // An empty confirm is almost certainly a client bug, and answering 200
    // with "nothing created" would look exactly like a successful confirm.
    throw new GoalGraphRequestError('selections must name at least one node', 'invalid_selections');
  }
  if (value.length > MAX_SELECTIONS_PER_CONFIRM) {
    throw new GoalGraphRequestError(
      `selections may name at most ${MAX_SELECTIONS_PER_CONFIRM} nodes`,
      'invalid_selections',
    );
  }
  return Object.freeze(value.map((entry, index) => parseSelection(entry, index)));
}

function parseSelection(value: unknown, index: number): GoalNodeSelection {
  if (!isRecord(value)) {
    throw new GoalGraphRequestError(`selections[${index}] must be an object`, 'invalid_selections');
  }
  const nodeId = parseNodeId(value.nodeId);
  if (value.as === 'commitment') return Object.freeze({ nodeId, as: 'commitment' as const });
  if (value.as === 'habit') {
    if (!isRecord(value.habit)) {
      throw new GoalGraphRequestError(
        `selections[${index}].habit must be an object stating the cadence and duration`,
        'invalid_selections',
      );
    }
    return Object.freeze({ nodeId, as: 'habit' as const, habit: value.habit });
  }
  throw new GoalGraphRequestError(
    `selections[${index}].as must be "commitment" or "habit"`,
    'invalid_selections',
  );
}

/**
 * What a PATCH on one node may ask for.
 *
 * One action, and it is the non-destructive one. #526 says deleting or
 * unlinking a node must not delete the canonical work unless the user chooses
 * that separately — so there is no `action: 'delete'` here to choose by
 * accident, and the route that would offer one does not exist. Adding it later
 * is a deliberate edit to a closed set rather than a new branch in a parser.
 */
export type GoalNodePatch = { readonly action: 'unlink' };

export function parseNodePatch(value: unknown): GoalNodePatch {
  if (!isRecord(value)) {
    throw new GoalGraphRequestError('body must be an object', 'invalid_body');
  }
  if (value.action !== 'unlink') {
    throw new GoalGraphRequestError('action must be "unlink"', 'invalid_action');
  }
  return Object.freeze({ action: 'unlink' as const });
}

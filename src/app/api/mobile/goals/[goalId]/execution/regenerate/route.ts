import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readBoundedText, requestBodyTooLargeResponse } from '../../../../../../../../lib/net/requestBody';
import {
  GoalGraphRequestError,
  goalGraphRequestResponse,
  parseGeneration,
} from '../../../../../../../../lib/goalGraph/goalGraphApi';
import {
  GoalGraphGenerationError,
  GoalGraphInvalidError,
  MemoryNotFoundError,
  regenerateGoalGraph,
} from '../../../../../../../../lib/services/mobile/goalGraphService';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

/**
 * "Read my goal again" (#526).
 *
 * Writes nothing, like `generate`. What makes it a separate route is the
 * number: the answer is the *next* generation, so a client can tell the new
 * reading from the one it was looking at, and two readings are diffable rather
 * than one silently replacing the other.
 *
 * Everything the user already confirmed survives. Links are keyed on a node's
 * generation-independent key — `step.s1`, not `g1.step.s1` — so a node they
 * turned into a commitment at generation 1 comes back as a `linked_commitment`
 * at generation 2, pointing at the same commitment. That is #526's
 * "graph regeneration preserves already confirmed canonical links", and it is
 * a property of how the link is filed rather than a merge this route performs.
 *
 * `fromGeneration` is the reading the client holds; absent means the first.
 * There is no server-side counter, because nothing stores the graph.
 */
export async function POST(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  // A body is optional here: regenerating from the first reading is the
  // common case and a client should not have to send `{}` to ask for it.
  let body: unknown = {};
  try {
    const text = await readBoundedText(request);
    if (text.trim() !== '') body = JSON.parse(text);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  const { goalId } = await context.params;
  try {
    const fromGeneration = parseGeneration((body as Record<string, unknown>)?.fromGeneration, 'fromGeneration');
    const graph = await regenerateGoalGraph(user.uid, goalId, new Date().toISOString(), fromGeneration);
    return Response.json({ success: true, graph });
  } catch (error) {
    if (error instanceof GoalGraphRequestError) return goalGraphRequestResponse(error);
    if (error instanceof MemoryNotFoundError) {
      return Response.json({ success: false, error: 'not found', reason: 'goal_not_found' }, { status: 404 });
    }
    if (error instanceof GoalGraphGenerationError) {
      return Response.json(
        { success: false, error: error.message, reason: 'not_a_confirmed_goal' },
        { status: 400 },
      );
    }
    if (error instanceof GoalGraphInvalidError) {
      console.error('[goalGraph] regenerated graph failed its own validation', error.codes);
      return mobileError('could not build an execution plan for this goal', 500);
    }
    console.error('[goalGraph] regenerating an execution graph failed', error);
    return mobileError('could not build an execution plan for this goal', 500);
  }
}

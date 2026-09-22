import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../../../lib/services/mobile/response';
import {
  GoalGraphRequestError,
  goalGraphRequestResponse,
  parseNodeId,
  parseNodePatch,
} from '../../../../../../../../../lib/goalGraph/goalGraphApi';
import {
  GoalGraphGenerationError,
  MemoryNotFoundError,
  unlinkGoalGraphNode,
} from '../../../../../../../../../lib/services/mobile/goalGraphService';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ goalId: string; nodeId: string }>;
}

/**
 * Detach a node from the work it produced (#526).
 *
 * The only action is `unlink`, and the omission is the point. #526's criterion
 * is that deleting or unlinking a node must not delete the canonical work
 * unless the user chooses that separately — so there is no `action: "delete"`
 * to reach by accident, and the route that would offer one does not exist.
 * `parseNodePatch` refuses anything else before this handler acts.
 *
 * What comes back names the Commitment or Habit that was released, so the
 * client can tell the user it is still in their week rather than leaving them
 * to find out. Nothing about that entity is changed by this call: the service
 * removes one document from `goalGraphLinks` and has no import path to either
 * store, which `tests/goalGraph/goalGraphBoundaries.test.ts` pins.
 *
 * A node with no link answers 404 — an unlink of something that was never
 * linked did not happen, and 200 would tell the client it did.
 */
export async function PATCH(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const { goalId, nodeId } = await context.params;
  try {
    parseNodePatch(body);
    const unlinked = await unlinkGoalGraphNode(user.uid, goalId, parseNodeId(nodeId));
    if (!unlinked) {
      return Response.json(
        { success: false, error: 'not found', reason: 'node_not_linked' },
        { status: 404 },
      );
    }
    return Response.json({
      success: true,
      unlinked,
      // Said out loud in the payload, not only in the docs: the thing this
      // node created is still the user's, and only the goal's claim on it is
      // gone. A client that showed "removed" here would be wrong.
      canonicalWorkKept: true,
    });
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
    console.error('[goalGraph] unlinking an execution node failed', error);
    return mobileError('could not unlink that step', 500);
  }
}

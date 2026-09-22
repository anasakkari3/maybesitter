import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../../lib/services/mobile/response';
import {
  GoalGraphRequestError,
  goalGraphRequestResponse,
  parseGeneration,
  parseSelections,
} from '../../../../../../../../lib/goalGraph/goalGraphApi';
import { GoalConfirmationError } from '../../../../../../../../lib/goalGraph/confirmGoalGraph';
import {
  GoalGraphGenerationError,
  GoalGraphInvalidError,
  MemoryNotFoundError,
  confirmGoalGraphSelections,
} from '../../../../../../../../lib/services/mobile/goalGraphService';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

/**
 * "Yes, do these" (#526).
 *
 * The one route in this feature that writes anything canonical. Each selected
 * node becomes a Commitment through the same sequence a captured commitment
 * goes through, or a Habit through the habits contract's own validator; a
 * node nobody selected creates nothing.
 *
 * Pressing it twice creates one thing. The link is claimed on a document id
 * derived from the node's generation-independent key, so the second request
 * finds the first decision and answers with it — `replayed` rather than
 * `created`. That is why this is safe to retry on a flaky connection, and why
 * a client may resend without checking first.
 *
 * `generation` is the reading the client is holding. There is no server-side
 * counter because slice 3 does not persist the graph; a selection naming a
 * node the rebuilt graph does not contain is refused and creates nothing.
 *
 * Partial success is the normal answer: `created`, `replayed` and `refused`
 * are all returned, and a refusal never prevents the other selections from
 * being honoured. 200 rather than 201 because a confirm that replayed
 * everything created nothing, and the client cannot know which it will be.
 */
export async function POST(request: Request, context: RouteContext) {
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

  const { goalId } = await context.params;
  try {
    const raw = body as Record<string, unknown>;
    const result = await confirmGoalGraphSelections(user.uid, goalId, new Date().toISOString(), {
      generation: parseGeneration(raw?.generation),
      selections: parseSelections(raw?.selections),
    });
    return Response.json({
      success: true,
      graph: result.graph,
      created: result.created,
      replayed: result.replayed,
      refused: result.refused,
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
    if (error instanceof GoalConfirmationError) {
      return Response.json({ success: false, error: error.message, reason: 'invalid_confirmation' }, { status: 400 });
    }
    if (error instanceof GoalGraphInvalidError) {
      console.error('[goalGraph] graph failed its own validation before a confirm', error.codes);
      return mobileError('could not build an execution plan for this goal', 500);
    }
    console.error('[goalGraph] confirming execution nodes failed', error);
    return mobileError('could not confirm those steps', 500);
  }
}

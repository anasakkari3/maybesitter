import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../../lib/services/mobile/response';
import {
  GoalGraphGenerationError,
  GoalGraphInvalidError,
  MemoryNotFoundError,
  generateGoalGraph,
} from '../../../../../../../../lib/services/mobile/goalGraphService';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

/**
 * Propose how a confirmed goal could actually happen (#526).
 *
 * POST rather than GET because it runs the decomposition engine, which may
 * call a model — but it is still read-only about the account: nothing is
 * created, nothing is stored, and the same request twice returns the same
 * graph. The acceptance criteria this route is the front of are "existing
 * stored Goal alone changes nothing in Daily Plan" and "generate writes no
 * Commitment/Habit", and `tests/goalGraph/goalGraphIsolation.test.ts` proves
 * both by comparing every user-scoped collection before and after.
 *
 * A goal id from another account answers 404, the same as one that does not
 * exist: any other answer tells a stranger whether an id is real.
 */
export async function POST(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { goalId } = await context.params;
  try {
    const graph = await generateGoalGraph(user.uid, goalId, new Date().toISOString());
    return Response.json({ success: true, graph });
  } catch (error) {
    if (error instanceof MemoryNotFoundError) {
      return Response.json({ success: false, error: 'not found', reason: 'goal_not_found' }, { status: 404 });
    }
    // A memory that is not a goal, or one the user revoked: the request names
    // something real that cannot have an execution graph, which is a 400 about
    // the request rather than a 404 about the id.
    if (error instanceof GoalGraphGenerationError) {
      return Response.json(
        { success: false, error: error.message, reason: 'not_a_confirmed_goal' },
        { status: 400 },
      );
    }
    if (error instanceof GoalGraphInvalidError) {
      console.error('[goalGraph] generated graph failed its own validation', error.codes);
      return mobileError('could not build an execution plan for this goal', 500);
    }
    console.error('[goalGraph] generating an execution graph failed', error);
    return mobileError('could not build an execution plan for this goal', 500);
  }
}

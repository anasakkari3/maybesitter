import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  GoalGraphRequestError,
  goalGraphRequestResponse,
  parseGenerationQuery,
  parsePeriod,
} from '../../../../../../../lib/goalGraph/goalGraphApi';
import {
  GoalGraphGenerationError,
  GoalGraphInvalidError,
  MemoryNotFoundError,
  readGoalExecutionState,
} from '../../../../../../../lib/services/mobile/goalGraphService';

export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ goalId: string }>;
}

/**
 * "Where is this goal actually up to" (#526).
 *
 * The first route in the issue's API list and the last one to exist. Without
 * it the feature could propose, materialize and regenerate, but the number
 * that says whether any of it happened — `deriveGoalGraphProgress` — had no
 * caller outside its own test, so #526's "a linked Commitment's completion
 * changes derived progress automatically" was a property of a library
 * function and of nothing a client could see.
 *
 * GET, unlike `generate`'s POST, because this is the cheap read a screen opens
 * with: it rebuilds the graph the same way, and answers with the progress the
 * canonical entities imply beside it. Nothing here is stored, so there is no
 * cached figure to be stale — the Commitment the user ticked off on another
 * device is read on this request, from the Commitment.
 *
 * `?generation=` is the reading the client holds, for the same reason the
 * POST routes take one: nothing persists the graph, so the server cannot know
 * which the user is looking at unless they say. Absent means the first.
 *
 * `?fromLocalDate=&toLocalDate=` scope "this period" for habit nodes. Both or
 * neither: the server has no clock and no zone here, and a window it invented
 * would make two reads of an unchanged account disagree across midnight.
 *
 * A goal id from another account answers 404, the same as one that never
 * existed: any other answer tells a stranger whether an id is real.
 */
export async function GET(request: Request, context: RouteContext) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { goalId } = await context.params;
  try {
    const query = new URL(request.url).searchParams;
    const period = parsePeriod(query.get('fromLocalDate'), query.get('toLocalDate'));
    const { graph, progress } = await readGoalExecutionState(
      user.uid,
      goalId,
      new Date().toISOString(),
      {
        generation: parseGenerationQuery(query.get('generation')),
        ...(period ? { period } : {}),
      },
    );
    return Response.json({ success: true, graph, progress });
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
      console.error('[goalGraph] read graph failed its own validation', error.codes);
      return mobileError('could not build an execution plan for this goal', 500);
    }
    console.error('[goalGraph] reading an execution graph failed', error);
    return mobileError('could not read this goal', 500);
  }
}

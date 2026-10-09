import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../../lib/auth/mobileAuth';
import { batchGoalPlanTimes, GoalPlanApiError } from '../../../../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ goalId: string; planId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const body = await readGoalPlanBody(request);
    const { goalId, planId } = await params;
    if (typeof body.timesId !== 'string' || !body.timesId || !Number.isInteger(body.timesRevision)
      || !body.preference || typeof body.preference !== 'object' || Array.isArray(body.preference)) {
      throw new GoalPlanApiError(400, 'invalid_preference');
    }
    const result = await batchGoalPlanTimes(
      user.uid,
      goalId,
      planId,
      body.timesId,
      Number(body.timesRevision),
      body.preference as Record<string, never>,
    );
    return Response.json({ success: true, ...result });
  } catch (error) { return goalPlanRouteError(error); }
}

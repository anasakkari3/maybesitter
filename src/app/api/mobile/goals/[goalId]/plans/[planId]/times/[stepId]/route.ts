import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../../lib/auth/mobileAuth';
import { chooseGoalPlanTime, GoalPlanApiError } from '../../../../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, { params }: { params: Promise<{ goalId: string; planId: string; stepId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const body = await readGoalPlanBody(request);
    const { goalId, planId, stepId } = await params;
    if (typeof body.timesId !== 'string' || !body.timesId) throw new GoalPlanApiError(400, 'invalid_body');
    const times = await chooseGoalPlanTime(user.uid, goalId, planId, stepId, body.timesId, Number(body.timesRevision), body.choice as Record<string, unknown>);
    return Response.json({ success: true, times });
  } catch (error) { return goalPlanRouteError(error); }
}

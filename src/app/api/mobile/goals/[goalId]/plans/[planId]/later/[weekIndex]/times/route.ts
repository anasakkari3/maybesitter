import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../../../lib/auth/mobileAuth';
import { createLaterWeekTimes } from '../../../../../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ goalId: string; planId: string; weekIndex: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    await readGoalPlanBody(request);
    const { goalId, planId, weekIndex } = await params;
    const { plan, times } = await createLaterWeekTimes(user.uid, goalId, planId, Number(weekIndex));
    return Response.json({ success: true, plan, times });
  } catch (error) { return goalPlanRouteError(error); }
}

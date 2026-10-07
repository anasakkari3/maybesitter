import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { readGoalPlan } from '../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError } from '../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ goalId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const { goalId } = await params;
    return Response.json({ success: true, ...await readGoalPlan(user.uid, goalId) });
  } catch (error) { return goalPlanRouteError(error); }
}

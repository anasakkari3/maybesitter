import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { listUpcomingGoalPlans } from '../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError } from '../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try { return Response.json({ success: true, items: await listUpcomingGoalPlans(user.uid) }); }
  catch (error) { return goalPlanRouteError(error); }
}

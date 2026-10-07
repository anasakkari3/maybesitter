import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { regenerateGoalPlan } from '../../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ goalId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const body = await readGoalPlanBody(request);
    const { goalId } = await params;
    const plan = await regenerateGoalPlan(user.uid, goalId, {
      currentPlanId: String(body.currentPlanId ?? ''), revision: Number(body.revision), idempotencyKey: String(body.idempotencyKey ?? ''),
    });
    return Response.json({ success: true, plan });
  } catch (error) { return goalPlanRouteError(error); }
}

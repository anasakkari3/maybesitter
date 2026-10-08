import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { confirmGoalPlan } from '../../../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ goalId: string; planId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const body = await readGoalPlanBody(request);
    const { goalId, planId } = await params;
    const result = await confirmGoalPlan(user.uid, goalId, planId, {
      planRevision: Number(body.planRevision), timesId: String(body.timesId ?? ''), timesRevision: Number(body.timesRevision), idempotencyKey: String(body.idempotencyKey ?? ''),
    });
    return Response.json({ success: true, ...result, ...(result.receipt.replayed ? { replayed: true } : {}) });
  } catch (error) { return goalPlanRouteError(error); }
}

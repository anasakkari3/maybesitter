import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { featureLockedResponse } from '../../../../../../../../lib/features/featureRoute';
import { regenerateGoalPlan } from '../../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, { params }: { params: Promise<{ goalId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const locked = await featureLockedResponse(user.uid, 'goal_plans');
  if (locked) return locked;
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const body = await readGoalPlanBody(request);
    const { goalId } = await params;
    const plan = await regenerateGoalPlan(user.uid, goalId, {
      currentPlanId: String(body.currentPlanId ?? ''), revision: Number(body.revision), idempotencyKey: String(body.idempotencyKey ?? ''),
      // Additive (#807): a body without `source` still asks the model.
      ...(body.source === 'template' ? { source: 'template' as const } : {}),
    });
    return Response.json({ success: true, plan });
  } catch (error) { return goalPlanRouteError(error); }
}

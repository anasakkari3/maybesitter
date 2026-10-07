import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { acceptGoalStatement } from '../../../../../../../lib/services/mobile/goalPlanService';
import { goalPlanRouteError, readGoalPlanBody } from '../../../../../../../lib/services/mobile/goalPlanRoute';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const disabled = moduleDisabledResponse('goalPlan');
  if (disabled) return disabled;
  try {
    const body = await readGoalPlanBody(request);
    const result = await acceptGoalStatement(user.uid, {
      summaryId: String(body.summaryId ?? ''), revision: Number(body.revision),
      understood: body.understood as { goalText: string }, idempotencyKey: String(body.idempotencyKey ?? ''),
    });
    return Response.json({ success: true, ...result });
  } catch (error) { return goalPlanRouteError(error); }
}

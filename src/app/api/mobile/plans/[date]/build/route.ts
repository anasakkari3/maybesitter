import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import { planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
import { buildDailyPlanOnDemand, titlesOf } from '../../../../../../../lib/services/dailyPlan/dailyPlanService';
import { loadDomainState } from '../../../../../../../lib/services/mobile/participantState';
import { getStorage } from '../../../../../../../lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Builds that date's plan now, because the user asked on the plan screen (#477).
 *
 * The same build the morning job runs, through the same function, minus the
 * push. Idempotent: a date that already has a plan answers 200 with that plan
 * and spends nothing, so a double tap or a retry after a lost response is safe.
 * The answer is the shape `GET /api/mobile/plans/[date]` returns.
 */
export async function POST(request: Request, { params }: { params: Promise<{ date: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { date } = await params;
  if (!isPlanDate(date)) return mobileError('date must be YYYY-MM-DD');

  const { stored } = await buildDailyPlanOnDemand(user.uid, date);
  const state = await loadDomainState(getStorage(), user.uid);
  return Response.json({ success: true, plan: planToDto(stored, titlesOf(Object.values(state.commitments))) });
}

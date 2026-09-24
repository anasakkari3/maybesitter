import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import { pendingProposalToDto, planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
import { fixedTimeForOffer } from '../../../../../../../lib/services/dailyPlan/planActions';
import {
  PlanDateOutOfRangeError,
  buildDailyPlanOnDemand,
  titlesOf,
} from '../../../../../../../lib/services/dailyPlan/dailyPlanService';
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

  let stored;
  try {
    ({ stored } = await buildDailyPlanOnDemand(user.uid, date));
  } catch (error) {
    if (error instanceof PlanDateOutOfRangeError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    throw error;
  }
  const state = await loadDomainState(getStorage(), user.uid);
  const commitments = Object.values(state.commitments);
  const titles = titlesOf(commitments);
  // The time taken now, read only when there is a live offer to check against
  // it (#611 guards): an offer that would land on it is withheld.
  const now = new Date();
  const taken = await fixedTimeForOffer(user.uid, stored, now, { storage: getStorage(), commitments });
  /*
   * `proposal` rides along because this route's contract, stated above, is
   * that it answers the shape `GET` returns. A freshly built plan has no
   * pending patch, so this is `null` in practice — but a client that renders
   * from the build response and a client that renders from `GET` must not see
   * two different shapes, or the second one grows a branch for a key the first
   * never sends.
   */
  return Response.json({ success: true, plan: planToDto(stored, titles), proposal: pendingProposalToDto(stored, titles, now, taken) });
}

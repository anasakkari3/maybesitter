import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../lib/services/dailyPlan/planSettings';
import { readStoredPlan } from '../../../../../../lib/services/dailyPlan/planStore';
import { pendingProposalToDto, planToDto } from '../../../../../../lib/services/dailyPlan/planDto';
import { titlesOf } from '../../../../../../lib/services/dailyPlan/dailyPlanService';
import { loadDomainState } from '../../../../../../lib/services/mobile/participantState';
import { getStorage } from '../../../../../../lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Today's plan, if the morning job built one (UC-3.10a, #194).
 *
 * 404 rather than an empty plan when there is none: "no plan was built for you
 * today" and "a plan was built and it is empty" are different things to tell
 * somebody, and a client that could not tell them apart would show an empty day
 * to a user whose delivery is simply switched off.
 *
 * `proposal` (#523) is the patch continuous replanning is offering against
 * this plan, or null. It rides on this response rather than on an endpoint of
 * its own because it is a property of the plan being shown: a second round
 * trip would be a spinner on every screen that renders the day, and a second
 * route would cost an entry in the route-guard census for a payload that is
 * already in the document this handler just read. It is assembled *here*
 * rather than inside `planToDto` so that mapper stays pure and synchronous —
 * `DailyPlanDto` is the plan in force, and the offer is a sibling of it, not
 * part of it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ date: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { date } = await params;
  if (!isPlanDate(date)) return mobileError('date must be YYYY-MM-DD');

  const stored = await readStoredPlan(user.uid, date);
  if (!stored) return mobileError('no plan for that date', 404);

  const state = await loadDomainState(getStorage(), user.uid);
  const titles = titlesOf(Object.values(state.commitments));
  return Response.json({
    success: true,
    plan: planToDto(stored, titles),
    proposal: pendingProposalToDto(stored, titles, new Date()),
  });
}

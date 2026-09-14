import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  MAX_REGENERATIONS_PER_DAY,
  isPlanDate,
} from '../../../../../../../lib/services/dailyPlan/planSettings';
import { regeneratePlan } from '../../../../../../../lib/services/dailyPlan/planActions';
import { planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
import { titlesOf } from '../../../../../../../lib/services/dailyPlan/dailyPlanService';
import { loadDomainState } from '../../../../../../../lib/services/mobile/participantState';
import { getStorage } from '../../../../../../../lib/storage';

export const dynamic = 'force-dynamic';

/** Rebuilds today's plan from what the commitments say now (UC-3.10a, #194). */
export async function POST(request: Request, { params }: { params: Promise<{ date: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { date } = await params;
  if (!isPlanDate(date)) return mobileError('date must be YYYY-MM-DD');

  const outcome = await regeneratePlan(user.uid, date);
  if (!outcome.ok) {
    if (outcome.reason === 'not_found') return mobileError('no plan for that date', 404);
    if (outcome.reason === 'limit_reached') {
      return Response.json(
        {
          success: false,
          error: `a plan can be rebuilt ${MAX_REGENERATIONS_PER_DAY} times a day`,
          reason: 'limit_reached',
        },
        { status: 429 },
      );
    }
    // Another device regenerated between the read and the write. The plan it
    // wrote is the current one, so this is a conflict, not a failure.
    return Response.json({ success: false, error: 'the plan changed while it was being rebuilt', reason: 'raced' }, { status: 409 });
  }

  const state = await loadDomainState(getStorage(), user.uid);
  return Response.json({ success: true, plan: planToDto(outcome.stored, titlesOf(Object.values(state.commitments))) });
}

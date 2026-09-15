import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import {
  PlanEditRejected,
  acceptPlan,
  dismissPlan,
  editPlan,
  parseEdit,
} from '../../../../../../../lib/services/dailyPlan/planActions';
import { planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
import { titlesOf } from '../../../../../../../lib/services/dailyPlan/dailyPlanService';
import { loadDomainState } from '../../../../../../../lib/services/mobile/participantState';
import { getStorage } from '../../../../../../../lib/storage';
import type { StoredDailyPlan } from '../../../../../../../lib/services/dailyPlan/planStore';

export const dynamic = 'force-dynamic';

/**
 * Accept, dismiss, or edit today's plan (UC-3.10a, #194).
 *
 * A refused edit is 422 with a reason code and an item id, and the stored plan
 * is untouched — not rewritten with the same values, not left half-applied.
 * 422 rather than 400 because the request was well-formed and understood: it
 * asked for a placement the plan's own constraints do not allow, which is a
 * thing to show the user next to the item, not a bug in the client.
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

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  let stored: StoredDailyPlan | null;
  try {
    if (body.action === 'accept') stored = await acceptPlan(user.uid, date);
    else if (body.action === 'dismiss') stored = await dismissPlan(user.uid, date);
    else if (body.action === 'edit') stored = await editPlan(user.uid, date, parseEdit(body));
    else return mobileError(`Unknown plan action: ${String(body.action)}`);
  } catch (error) {
    if (error instanceof PlanEditRejected) {
      return Response.json(
        { success: false, error: error.message, reason: error.reason, itemId: error.itemId },
        { status: 422 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'the action failed', 500);
  }

  if (!stored) return mobileError('no plan for that date', 404);
  const state = await loadDomainState(getStorage(), user.uid);
  return Response.json({ success: true, plan: planToDto(stored, titlesOf(Object.values(state.commitments))) });
}

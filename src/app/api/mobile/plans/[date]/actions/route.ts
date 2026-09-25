import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import {
  PlanEditRejected,
  PlanProposalRejected,
  PlanProtectionRejected,
  acceptPlan,
  acceptPlanProposal,
  dismissPlan,
  editPlan,
  fixedTimeForOffer,
  parseEdit,
  parseProtection,
  rejectPlanProposal,
  setBlockProtection,
} from '../../../../../../../lib/services/dailyPlan/planActions';
import { pendingProposalToDto, planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
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
 *
 * `protect` (#522) is the fifth action and deliberately arrives *here*, on the
 * boundary that already owns the plan document, rather than on a planner
 * service of its own. It declares whose decision one block's position is; it
 * moves nothing, and the plan in the response is the same plan. A refusal is
 * 422 for the same reason as an edit's, carrying `blockId` where an edit
 * carries `itemId`.
 *
 * `accept_proposal` and `reject_proposal` (#523) are the sixth and seventh,
 * and arrive here for the same reason: they are things a person does to the
 * plan document this route already owns, and a route of its own would have
 * bought a second auth surface and a second entry in the route-guard census
 * for two verbs. Both are 422 on refusal, carrying `reason` — `no_proposal`
 * when there is nothing to act on, `stale_proposal` when the patch describes
 * a plan state that has moved on. Neither carries an `itemId` or a `blockId`:
 * the refusal is about the offer, not about a row in it.
 *
 * Since the #611 guards, `stale_proposal` on accept also covers an offer
 * whose day is over, one a meeting has landed on since it was solved, and one
 * replaced by a newer offer than the `proposalId` the client names. The body
 * of either answer may carry that `proposalId`; without it, whatever is
 * pending is answered. A declined offer the client did not name is refused as
 * `stale_proposal` too, and is not remembered as declined.
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

  let body: { action?: unknown; proposalId?: unknown };
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
    else if (body.action === 'protect') {
      const outcome = await setBlockProtection(user.uid, date, parseProtection(body));
      stored = outcome?.stored ?? null;
    } else if (body.action === 'accept_proposal' || body.action === 'reject_proposal') {
      // The offer the client was shown, when it names one (#611 guards): a
      // proposal replaced since is refused, never installed or remembered as
      // declined unseen.
      const shown = typeof body.proposalId === 'string' ? { proposalId: body.proposalId } : {};
      stored = body.action === 'accept_proposal'
        ? await acceptPlanProposal(user.uid, date, shown)
        : await rejectPlanProposal(user.uid, date, shown);
    }
    else return mobileError(`Unknown plan action: ${String(body.action)}`);
  } catch (error) {
    if (error instanceof PlanEditRejected) {
      return Response.json(
        { success: false, error: error.message, reason: error.reason, itemId: error.itemId },
        { status: 422 },
      );
    }
    if (error instanceof PlanProposalRejected) {
      return Response.json(
        { success: false, error: error.message, reason: error.reason },
        { status: 422 },
      );
    }
    if (error instanceof PlanProtectionRejected) {
      return Response.json(
        { success: false, error: error.message, reason: error.reason, blockId: error.blockId },
        { status: 422 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'the action failed', 500);
  }

  if (!stored) return mobileError('no plan for that date', 404);
  const state = await loadDomainState(getStorage(), user.uid);
  const commitments = Object.values(state.commitments);
  const titles = titlesOf(commitments);
  // The time taken now, read only when there is a live offer to check against
  // it (#611 guards): an offer that would land on it is withheld.
  const now = new Date();
  const taken = await fixedTimeForOffer(user.uid, stored, now, { storage: getStorage(), commitments });
  return Response.json({
    success: true,
    plan: planToDto(stored, titles, { commitments }),
    // The same key GET answers with, on every action: a client that has just
    // accepted or rejected a patch learns from its own response that the offer
    // is gone, instead of re-fetching to find out.
    proposal: pendingProposalToDto(stored, titles, now, taken),
  });
}

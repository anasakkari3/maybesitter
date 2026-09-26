import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import { planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
import { PlanDateOutOfRangeError, titlesOf } from '../../../../../../../lib/services/dailyPlan/dailyPlanService';
import {
  WeekDecisionsInvalid,
  acceptWeekDay,
  parseWeekDecisions,
  weekToDto,
} from '../../../../../../../lib/services/dailyPlan/weekPlan';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Accepts one day of the week's proposals (CL5b).
 *
 * Body: `{ date, moves?, drops? }` — the day, and the decisions the week was
 * shown under, so the day stored is the day the person saw. The date's plan
 * is built through the daily flow's own build and accepted through its own
 * accept, so Today and the plan screen show it on that date as any plan.
 *
 * 400 `date_out_of_range` outside today … today+6. 409 `already_planned` when
 * the date has a plan: that plan is the day's, and is left exactly as it is.
 * Both successful and conflicting answers carry the week as it stands.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let date: string;
  let decisions;
  try {
    const body = await readJsonBody<unknown>(request);
    const candidate = typeof body === 'object' && body !== null ? (body as { date?: unknown }).date : undefined;
    if (!isPlanDate(candidate)) return mobileError('date must be YYYY-MM-DD');
    date = candidate;
    decisions = parseWeekDecisions(body);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    if (error instanceof WeekDecisionsInvalid) return mobileError(error.message);
    return mobileError('Invalid JSON request body');
  }

  let result;
  try {
    result = await acceptWeekDay(user.uid, date, decisions);
  } catch (error) {
    if (error instanceof PlanDateOutOfRangeError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    throw error;
  }

  const week = weekToDto(result.layout);
  if (result.outcome === 'already_planned') {
    return Response.json({ success: false, error: 'that day already has a plan', reason: 'already_planned', week }, { status: 409 });
  }
  const commitments = result.layout.commitments;
  return Response.json({ success: true, plan: planToDto(result.stored, titlesOf(commitments), { commitments }), week });
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { isPlanDate } from '../../../../../../../lib/services/dailyPlan/planSettings';
import { planToDto } from '../../../../../../../lib/services/dailyPlan/planDto';
import { PlanEditRejected } from '../../../../../../../lib/services/dailyPlan/planActions';
import { PlanDateOutOfRangeError, titlesOf } from '../../../../../../../lib/services/dailyPlan/dailyPlanService';
import {
  WEEK_BODY_LIMIT_BYTES,
  WeekDecisionsInvalid,
  acceptWeekDay,
  composeWeek,
  parseShown,
  parseWeekDecisions,
  reserveWeekPlan,
  weekRateLimitedResponse,
  weekToDto,
} from '../../../../../../../lib/services/dailyPlan/weekPlan';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Accepts one day of the week's proposals (CL5b).
 *
 * Body: `{ date, shown, moves?, drops? }` — the day, the ids of the steps
 * its card showed, and the decisions the week was shown under. The date's
 * plan is built through the daily flow's own build and accepted through its
 * own accept, so Today and the plan screen show it on that date as any plan.
 *
 * 400 `date_out_of_range` outside today … today+6. 409 `already_planned` when
 * the date has a plan: that plan is the day's, and is left exactly as it is.
 * 409 `week_changed` when the day is no longer what its card showed (another
 * device changed the account, or a move had not been redrawn yet): nothing is
 * stored, and the week comes back to redraw (I1). Bounded body (32 KB) and
 * the week's daily count (429 `week_rate_limited`), as `POST /plans/week`.
 * Every answer past the parse carries the week as it stands.
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
  let shown: string[];
  try {
    const body = await readJsonBody<unknown>(request, { limitBytes: WEEK_BODY_LIMIT_BYTES });
    const candidate = typeof body === 'object' && body !== null ? (body as { date?: unknown }).date : undefined;
    if (!isPlanDate(candidate)) return mobileError('date must be YYYY-MM-DD');
    date = candidate;
    decisions = parseWeekDecisions(body);
    shown = parseShown(body);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    if (error instanceof WeekDecisionsInvalid) return mobileError(error.message);
    return mobileError('Invalid JSON request body');
  }

  if (!await reserveWeekPlan(user.uid)) return weekRateLimitedResponse();

  let result;
  try {
    result = await acceptWeekDay(user.uid, date, decisions, shown);
  } catch (error) {
    // Never a 500 for a day with nothing to accept (review of audit #4).
    if (error instanceof PlanEditRejected) {
      // With the week as it is now, when it can be read, so the phone redraws
      // from it (`WeekEmptyDayError`) rather than from the day it was shown.
      let week: ReturnType<typeof weekToDto> | undefined;
      try {
        week = weekToDto(await composeWeek(user.uid, decisions));
      } catch {
        week = undefined;
      }
      return Response.json({ success: false, error: error.message, reason: error.reason, ...(week ? { week } : {}) }, { status: 422 });
    }
    if (error instanceof PlanDateOutOfRangeError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    throw error;
  }

  const week = weekToDto(result.layout);
  if (result.outcome === 'already_planned') {
    return Response.json({ success: false, error: 'that day already has a plan', reason: 'already_planned', week }, { status: 409 });
  }
  if (result.outcome === 'empty_day') {
    return Response.json({ success: false, error: 'that day has nothing to plan', reason: 'empty_plan', week }, { status: 422 });
  }
  if (result.outcome === 'week_changed') {
    return Response.json({ success: false, error: 'the week changed since it was shown', reason: 'week_changed', week }, { status: 409 });
  }
  const commitments = result.layout.commitments;
  return Response.json({ success: true, plan: planToDto(result.stored, titlesOf(commitments), { commitments }), week });
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  WEEK_BODY_LIMIT_BYTES,
  WeekDecisionsInvalid,
  composeWeek,
  parseWeekDecisions,
  readSavedWeek,
  reserveWeekPlan,
  weekRateLimitedResponse,
  weekToDto,
} from '../../../../../../lib/services/dailyPlan/weekPlan';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * «خطّط أسبوعي»: the week's proposals, today … today+6 (CL5b).
 *
 * The existing daily planner, once per date, one proposed step per day, with
 * the person's moves and drops applied (`lib/services/dailyPlan/weekPlan.ts`).
 * It writes nothing — a proposal is not a plan until the person accepts its
 * day through `POST /api/mobile/plans/week/accept` — so it is safe to call
 * again after every move.
 *
 * A route of its own rather than `POST /plans/[date]/build` with a wider
 * range: a build *stores* `plans/{date}`, which the morning job and every
 * reader then treat as that day's plan, and a week the person only looked at
 * must not stand in for seven mornings. Moves also span two dates, which no
 * per-date route can express.
 *
 * POST, not GET, because the decisions are a body: they are the client's to
 * hold until a day is accepted, and a query string would put them in logs.
 * The body is bounded at 32 KB while it is read (a full one is about 25 KB),
 * and each call spends one of a generous daily count (`MAX_WEEK_PLANS_PER_DAY`):
 * a call composes seven days, and a client in a loop would spend that on
 * every turn. Over the count, 429 `week_rate_limited`.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let decisions;
  try {
    decisions = parseWeekDecisions(await readJsonBody(request, { limitBytes: WEEK_BODY_LIMIT_BYTES }));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    if (error instanceof WeekDecisionsInvalid) return mobileError(error.message);
    return mobileError('Invalid JSON request body');
  }

  if (!await reserveWeekPlan(user.uid)) return weekRateLimitedResponse();
  const layout = await composeWeek(user.uid, decisions);
  return Response.json({ success: true, week: weekToDto(layout) });
}

/**
 * The days of the next seven the person saved from the week view, with the
 * steps each holds (CL5b, I4): what the Calendar's 7-day strip draws on those
 * dates. Cheap — the account document and seven plan documents, no compose —
 * so it is not counted against the daily cap.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return Response.json({ success: true, ...(await readSavedWeek(user.uid)) });
}


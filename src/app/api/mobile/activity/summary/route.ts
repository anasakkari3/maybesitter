import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { weeklySummaryFor } from '../../../../../../lib/services/activity/activityService';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/activity/summary?weekStart=YYYY-MM-DD
 *
 * The week's three counts and the account's Moments (UC-3.15, #201).
 *
 * `weekStart` defaults to the current week in the timezone and locale on
 * `users/{uid}` — Sunday for Arabic and Hebrew, Monday for English — rather
 * than to anything the client says, so two devices in two zones agree on which
 * week they are looking at. A `weekStart` that is not a calendar date is
 * ignored rather than refused, for the same reason the cursor is.
 *
 * Nothing here is a judgement: there is no streak, no percentage, no count of
 * what did not happen, and no notification. See weeklySummary for why.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  return Response.json(await weeklySummaryFor({
    uid: user.uid,
    weekStart: searchParams.get('weekStart'),
  }));
}

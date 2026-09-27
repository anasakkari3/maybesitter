import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  GOOGLE_BUSY_LOOK_AHEAD_DAYS,
  listGoogleBusyBlocks,
  syncGoogleCalendarBusy,
} from '../../../../../../../lib/integrations/google/googleCalendarBusy';
import { googleFailureResponse } from '../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../lib/integrations/google/googleRuntime';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

/**
 * The Google busy blocks the Calendar tab draws beside the phone's (CL6a).
 *
 * The six fields `lib/calendar/busyBlocks.ts` stores and nothing else: the
 * phone's own blocks are already on the phone, so only `google` rows come back.
 * The window is a fixed look-ahead from now, not a query parameter.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  try {
    const runtime = googleRuntime();
    const now = runtime.now();
    const start = new Date(now.getTime() - DAY_MS).toISOString();
    const end = new Date(now.getTime() + (GOOGLE_BUSY_LOOK_AHEAD_DAYS + 1) * DAY_MS).toISOString();
    const blocks = await listGoogleBusyBlocks(user.uid, { startsAt: start, endsAt: end }, runtime);
    return Response.json({
      success: true,
      blocks: blocks.map((block) => ({
        blockId: block.blockId,
        sourceId: block.sourceId,
        sourceKind: block.sourceKind,
        startAt: block.startAt,
        endAt: block.endAt,
        allDay: block.allDay,
      })),
    });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

/**
 * Read the next fourteen days of busy time from Google now, through the same
 * writer the phone's calendar uses. Refused without the Trust Center's
 * calendar consent, like the phone's upload.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  try {
    return Response.json({ success: true, ...(await syncGoogleCalendarBusy(user.uid, googleRuntime())) });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { listTodayRanked } from '../../../../../../lib/services/mobile/commitmentService';
import { commitmentListResponse } from '../../../../../../lib/services/mobile/response';
import {
  listDeviceCalendarLinks,
  orphanedDeviceCalendarLinks,
} from '../../../../../../lib/services/calendar/deviceCalendarLinks';
import { dateFromOptionalIso } from '../../../../../../lib/services/mobile/time';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const ranked = await listTodayRanked({
    now: dateFromOptionalIso(searchParams.get('referenceTime'), new Date(), 'referenceTime'),
    timezone: searchParams.get('timezone') ?? undefined,
    participantId: user.uid,
  });
  // One read for the whole list (UC-3.1, #185). The calendar sync reconciles
  // against the same response the screens render, so the two can never
  // disagree about which commitment owns which event.
  const links = await listDeviceCalendarLinks(user.uid);
  // The orphans travel with Today and with Today only. Both lists carry the
  // links for their own rows, but "which events have no commitment left" is one
  // answer about the whole account: sending it on both would have two responses
  // asking the phone to delete the same event, and sending it on Upcoming
  // instead would put it on the list a user may never open.
  return Response.json(commitmentListResponse(
    ranked.items,
    ranked.ranking,
    links,
    orphanedDeviceCalendarLinks(links, ranked.calendarEligibleIds),
  ));
}

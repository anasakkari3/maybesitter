import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  CalendarSettingsValidationError,
  readCalendarSettings,
  saveCalendarWriteTarget,
} from '../../../../../../lib/services/calendar/calendarSettings';

export const dynamic = 'force-dynamic';

/** Where this account's confirmed commitments go, if anywhere (UC-3.1, #185). */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const settings = await readCalendarSettings(user.uid);
  return Response.json({ success: true, calendarSettings: settingsDto(settings) });
}

/**
 * Sets the write target.
 *
 * The server stores the target and nothing else. Which calendar on the phone
 * was picked is a device answer — a calendar id means nothing on another device
 * — so it stays on the device that picked it; see `calendarSettings.ts`.
 *
 * Turning the target off writes no event from then on and removes none of the
 * events already written. "Stop adding" and "remove what you added" are two
 * different sentences, and the second one has its own button.
 */
export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: { writeTarget?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    const settings = await saveCalendarWriteTarget(user.uid, body.writeTarget, new Date());
    return Response.json({ success: true, calendarSettings: settingsDto(settings) });
  } catch (error) {
    if (error instanceof CalendarSettingsValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the calendar settings', 500);
  }
}

/** `updatedAt` is optional on the record and always present on the wire, as null. */
function settingsDto(settings: { writeTarget: string; updatedAt?: string }) {
  return { writeTarget: settings.writeTarget, updatedAt: settings.updatedAt ?? null };
}

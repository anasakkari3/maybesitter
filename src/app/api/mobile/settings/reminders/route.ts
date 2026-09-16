import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  ReminderSettingsValidationError,
  readReminderSettings,
  saveReminderSettings,
  type ReminderSettings,
  type ReminderSettingsInput,
} from '../../../../../../lib/services/mobile/reminderSettingsService';

export const dynamic = 'force-dynamic';

/**
 * Soft reminders: whether they are on, how far ahead, and the quiet hours they
 * obey (UC-3.11, #196).
 *
 * The quiet hours on this response are the account's one copy — they are
 * stored on the routine profile and read from there. See
 * `lib/services/mobile/reminderSettingsService` for why there is not a second
 * copy under `reminderSettings`.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const settings = await readReminderSettings(user.uid);
  return Response.json({ success: true, reminderSettings: settingsDto(settings) });
}

export async function PUT(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return mobileError('Invalid JSON request body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return mobileError('body must be an object');
  }

  const input: ReminderSettingsInput = {
    ...(body.softEnabled === undefined ? {} : { softEnabled: body.softEnabled as boolean }),
    ...(body.softLeadMinutes === undefined ? {} : { softLeadMinutes: body.softLeadMinutes as number }),
    // Present-with-null and absent are different instructions: one clears the
    // window, the other leaves whatever the survey said alone. `in` is the
    // only test that tells them apart.
    ...('quietHours' in body ? { quietHours: quietHoursOf(body.quietHours) } : {}),
    // #196's body puts the zone inside `quietHours`; a top-level one is
    // accepted as well so a client that sends the profile's shape is not
    // refused for being right in the other vocabulary.
    ...(timezoneOf(body) === null ? {} : { timezone: timezoneOf(body) as string }),
  };

  try {
    const settings = await saveReminderSettings(user.uid, input, new Date().toISOString());
    return Response.json({ success: true, reminderSettings: settingsDto(settings) });
  } catch (error) {
    if (error instanceof ReminderSettingsValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the reminder settings', 500);
  }
}

/**
 * The window as sent, or null. Its `timezone` is lifted out here because the
 * profile keeps the zone beside the window rather than inside it, and #196's
 * body puts it inside — one shape on the wire, one shape in storage, and the
 * translation in exactly one place.
 */
function quietHoursOf(value: unknown): { start: string; end: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return { start: '', end: '' };
  const raw = value as Record<string, unknown>;
  return { start: String(raw.start ?? ''), end: String(raw.end ?? '') };
}

/** The zone, from inside `quietHours` where #196 puts it, or beside it. */
function timezoneOf(body: Record<string, unknown>): string | null {
  const nested = body.quietHours;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const zone = (nested as Record<string, unknown>).timezone;
    if (typeof zone === 'string' && zone !== '') return zone;
  }
  return typeof body.timezone === 'string' && body.timezone !== '' ? body.timezone : null;
}

/** `quietHours` always present on the wire, as null when there is none. */
function settingsDto(settings: ReminderSettings) {
  return {
    softEnabled: settings.softEnabled,
    softLeadMinutes: settings.softLeadMinutes,
    quietHours: settings.quietHours
      ? { start: settings.quietHours.start, end: settings.quietHours.end, timezone: settings.timezone }
      : null,
    timezone: settings.timezone,
    updatedAt: settings.updatedAt ?? null,
  };
}

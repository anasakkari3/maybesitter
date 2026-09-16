/**
 * Whether now falls inside this account's quiet hours (UC-3.0b, #184).
 *
 * ── There is one quiet-hours window, and it is the routine profile's ──
 *
 * UC-3.11 (#196) asked for `users/{uid}.reminderSettings.quietHours`. They
 * already live at `users/{uid}.profile.routine.quietHours`: the routine survey
 * (UC-2.7a, #167) writes them, `resolveNextStepAccess` reads them to decide
 * whether to show a card at 23:00, and `routineProfileToFacts` files them on
 * the memory screen as `quiet_hours:22:30-07:30`.
 *
 * A second copy would disagree the first time somebody edited one of them, and
 * the disagreement would be silent in the worst direction: the next step would
 * go quiet at a time the push service thought was fine to push at. So
 * `reminderSettings` holds only what is genuinely new — whether soft reminders
 * are on, and how far ahead they land — and
 * `PUT /api/mobile/settings/reminders` writes quiet hours *through* to the
 * routine profile. See `lib/services/mobile/reminderSettingsService`.
 *
 * ── The window test is not reimplemented here ────────────────────
 *
 * `isWithinWindow` already crosses midnight correctly and reads the wall clock
 * through `Intl` with an explicit zone, which is what makes it right on a DST
 * day. Two implementations of "is 23:00 inside 22:00–07:00" is two chances to
 * get the wrap backwards, and getting it backwards suppresses all day and
 * pushes all night.
 */
import { isWithinWindow } from '../services/mobile/nextStepAccess';
import { readRoutineProfile } from '../services/mobile/routineProfileService';
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../storage';
import type { RoutineTimeWindow } from '../../src/contracts/v1/routineContracts';

/** The zone every read falls back to when the account has never said. */
export const FALLBACK_TIMEZONE = 'UTC';

export interface QuietHours {
  /** Null when this account has never set one; nothing is ever suppressed. */
  readonly window: RoutineTimeWindow | null;
  /** The zone `window` is wall-clock in. */
  readonly timezone: string;
}

export const NO_QUIET_HOURS: QuietHours = Object.freeze({ window: null, timezone: FALLBACK_TIMEZONE });

/**
 * Pure: whether `at` is inside the window.
 *
 * An account with no window is never quiet. That is deliberate and it is the
 * safe direction here in a way it is not elsewhere: the alternative — treating
 * "unset" as "always quiet" — would silently disable every push for everyone
 * who has not answered the survey, and nobody would see an error.
 */
export function isInQuietHours(quietHours: QuietHours, at: Date): boolean {
  if (!quietHours.window) return false;
  return isWithinWindow(quietHours.window, at, quietHours.timezone);
}

interface TimezoneBearingUser {
  timezone?: string | null;
}

export interface ReadQuietHoursOptions {
  storage?: StorageAdapter;
}

/**
 * This account's quiet hours, from the one place they are stored.
 *
 * The zone comes from the profile that carries the window, not from the
 * account's `timezone` field, because the two can disagree: the window is
 * wall-clock in the zone it was *answered* in, and re-reading it in a zone the
 * user has since moved to would shift their quiet hours by the flight.
 * `users/{uid}.timezone` is used only when there is no profile at all, and
 * then only to keep the fallback from being a fiction.
 */
export async function readQuietHours(
  uid: string,
  options: ReadQuietHoursOptions = {},
): Promise<QuietHours> {
  requireUserId(uid);
  const storage = options.storage ?? getStorage();
  const profile = await readRoutineProfile(uid, { storage });
  if (profile?.quietHours) {
    return Object.freeze({ window: profile.quietHours, timezone: profile.timezone });
  }
  const user = await storage.get<TimezoneBearingUser>(userDoc(uid));
  return Object.freeze({
    window: null,
    timezone: typeof user?.timezone === 'string' && user.timezone ? user.timezone : FALLBACK_TIMEZONE,
  });
}

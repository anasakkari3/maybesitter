/**
 * The exact scopes the Google verification submission covers (UC-1.8 #152).
 *
 * These two strings are the submission. Changing either one means a **new
 * review**, so they live in one place, are asserted by a test, and must not be
 * edited to make a feature work — the feature waits for the review instead.
 *
 * `calendar.events` — read when the user is busy (start and end only; titles,
 * descriptions, attendees and locations are never stored) and, only if the
 * user turns it on, add commitments they explicitly confirmed.
 *
 * `calendar.calendarlist.readonly` — the narrowest calendar-list scope. Names
 * only, so the user can choose which calendars count as busy.
 *
 * Deliberately **not** requested: `calendar` (full access, including sharing
 * and deleting calendars) and `calendar.readonly` (broader than a list).
 * Neither requested scope is restricted, so no CASA assessment applies.
 */
export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
] as const;

/** Scopes Google classifies as restricted. Requesting one triggers CASA. */
export const RESTRICTED_OR_BROADER_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.acls',
  'https://www.googleapis.com/auth/calendar.settings.readonly',
] as const;

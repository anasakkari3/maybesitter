/**
 * Where this account's confirmed commitments are written (UC-3.1, #185).
 *
 * ── Why the target is on the server and the calendar is not ──────
 *
 * `writeTarget` is an account-level answer: it is the sentence "put my
 * commitments in my calendar", and UC-3.3 (#187) adds `google` to the same
 * field so that turning one on turns the other off by construction rather than
 * by two switches that have to be kept disagreeing. One write target at a time
 * is the product decision, and a single-valued field is what makes it one.
 *
 * Which *calendar* on the phone is not an account-level answer and is
 * deliberately absent from here. A calendar id comes from EventKit or from the
 * Android provider and means nothing on another device — the same string on the
 * user's iPad is a different calendar or no calendar at all. Storing it here
 * would be a value that is right on exactly one device and silently wrong
 * everywhere else, so the chosen calendar lives on the device that chose it and
 * this field says only whether anything is written at all.
 *
 * ── Off is the default, and an unreadable record reads as off ────
 *
 * The failure mode of guessing is an event appearing in somebody's shared work
 * calendar that they never asked for, which is the one direction this must not
 * fail in. So a record written by a future schema, or edited by hand, reads as
 * `off` rather than as the value it half-resembles.
 */
import { getStorage, type StorageAdapter } from '../../storage';
import { userDoc } from '../../storage/paths';

export const CALENDAR_WRITE_TARGETS = ['off', 'device', 'google'] as const;
export type CalendarWriteTarget = (typeof CALENDAR_WRITE_TARGETS)[number];

/** Until the user turns it on, nothing is written anywhere. */
export const DEFAULT_CALENDAR_WRITE_TARGET: CalendarWriteTarget = 'off';

export interface CalendarSettings {
  writeTarget: CalendarWriteTarget;
  /** When the target last changed. Diagnostic, never a gate. */
  updatedAt?: string;
}

/** The user document, as this module reads and writes it. */
export interface CalendarSettingsBearingUser {
  calendarSettings?: CalendarSettings;
}

export class CalendarSettingsValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'CalendarSettingsValidationError';
  }
}

export function isCalendarWriteTarget(value: unknown): value is CalendarWriteTarget {
  return (CALENDAR_WRITE_TARGETS as readonly unknown[]).includes(value);
}

/** The stored target, or `off` for an account that has never chosen. */
export function calendarSettingsOf(user: CalendarSettingsBearingUser | null): CalendarSettings {
  const stored = user?.calendarSettings;
  if (!stored || !isCalendarWriteTarget(stored.writeTarget)) {
    return { writeTarget: DEFAULT_CALENDAR_WRITE_TARGET };
  }
  return {
    writeTarget: stored.writeTarget,
    ...(typeof stored.updatedAt === 'string' ? { updatedAt: stored.updatedAt } : {}),
  };
}

export interface CalendarSettingsDeps {
  storage?: StorageAdapter;
}

function storageOf(deps: CalendarSettingsDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

export async function readCalendarSettings(
  uid: string,
  deps: CalendarSettingsDeps = {},
): Promise<CalendarSettings> {
  return calendarSettingsOf(await storageOf(deps).get<CalendarSettingsBearingUser>(userDoc(uid)));
}

/**
 * Records the target the user chose.
 *
 * Read-modify-write inside a transaction rather than a merge, because the user
 * document carries the trust record, the locale and the domain version, and a
 * settings write that clobbered one of those would be a privacy answer lost to
 * a calendar toggle.
 *
 * Turning the target *off* deliberately deletes nothing. The events already in
 * the calendar are the user's, in their calendar, and a switch labelled "stop
 * adding" that also removed a month of entries would be the product deciding
 * what a sentence meant on the user's behalf. Removing them is its own button,
 * `removeLinkedEvents` on the device, which says what it does.
 */
export async function saveCalendarWriteTarget(
  uid: string,
  writeTarget: unknown,
  now: Date,
  deps: CalendarSettingsDeps = {},
): Promise<CalendarSettings> {
  if (!isCalendarWriteTarget(writeTarget)) {
    throw new CalendarSettingsValidationError(
      `writeTarget must be one of ${CALENDAR_WRITE_TARGETS.join(', ')}`,
      'invalid_write_target',
    );
  }
  return storageOf(deps).runTransaction(async (tx) => {
    const user = await tx.get<CalendarSettingsBearingUser>(userDoc(uid));
    const next: CalendarSettings = { writeTarget, updatedAt: now.toISOString() };
    tx.set(userDoc(uid), { ...(user ?? {}), calendarSettings: next });
    return next;
  });
}

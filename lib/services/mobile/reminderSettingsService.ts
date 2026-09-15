/**
 * Soft reminders, as the account holds them (UC-3.11 #196, UC-3.0b #184).
 *
 * ── Where quiet hours live, and why not here ─────────────────────
 *
 * #196 specifies `users/{uid}.reminderSettings.quietHours`. They already exist
 * at `users/{uid}.profile.routine.quietHours`:
 *
 *   - the routine survey writes them (UC-2.7a, #167), from onboarding and from
 *     Settings → Routine;
 *   - `resolveNextStepAccess` reads them to decide whether a next-step card may
 *     be shown at 23:00;
 *   - `routineProfileToFacts` files them as `quiet_hours:22:30-07:30`, which is
 *     the row the "what MaybeSitter knows" screen renders.
 *
 * Two stores would disagree the first time somebody edited one, and the
 * disagreement is silent in the worst direction: the next step would go quiet
 * at a time the push service still thought was fine to push at, and the memory
 * screen would show hours nothing obeyed. Migrating the *readers* onto a new
 * `reminderSettings.quietHours` would mean rewriting the next-step gate, the
 * fact derivation and the survey's own round trip, for no behaviour anybody
 * asked for.
 *
 * So the routine profile stays authoritative and `reminderSettings` holds only
 * what is genuinely new — whether soft reminders are on, and how far ahead they
 * land. `PUT /api/mobile/settings/reminders` keeps the wire shape #196 named,
 * including `quietHours`, and writes that half *through* to the profile using
 * the survey's own writer, so the derived facts are reconciled by the same code
 * that reconciles them when the survey is saved.
 *
 * `tests/mobile/reminderSettingsRoute.test.ts` asserts that no `quietHours` key
 * ever appears under `reminderSettings`, so the second store cannot come back
 * by accident.
 *
 * ── Writing quiet hours can create a routine profile ─────────────
 *
 * When the account has never answered the survey, the write-through creates a
 * profile holding the quiet hours and nothing else. That files one fact the
 * user did not state — `reminder_intensity:softAwareness` — because the profile
 * contract requires the field. It is the same thing the survey does when that
 * question is left unanswered (see `toRoutinePayload` in the app), it is the
 * gentlest setting rather than a guess about the person, and one consistent
 * behaviour is better than two.
 */
import {
  buildRoutineProfile,
  isValidTimezone,
  parseRoutineProfileInput,
  type RoutineProfileInput,
  type RoutineTimeWindow,
  type UserRoutineProfile,
} from '../../../src/contracts/v1/routineContracts';
import { readRoutineProfile, saveRoutineProfile } from './routineProfileService';
import { getStorage, requireUserId, userDoc, type StorageAdapter } from '../../storage';

/**
 * Soft reminders are on for a new account.
 *
 * #196's first acceptance criterion is that a fresh install with notifications
 * granted schedules a reminder with no flag set, and every stage of this is
 * *local*: nothing is sent, nothing leaves the phone, and the OS permission
 * prompt is still a separate yes the user has to give. Defaulting off would
 * mean the permission the user just granted did nothing.
 */
export const DEFAULT_SOFT_ENABLED = true;
export const DEFAULT_SOFT_LEAD_MINUTES = 60;
/** The three the settings screen offers, and the only three accepted. */
export const SOFT_LEAD_MINUTES: readonly number[] = [60, 30, 15];

export interface ReminderSettings {
  readonly softEnabled: boolean;
  readonly softLeadMinutes: number;
  /** Read from the routine profile; never stored under `reminderSettings`. */
  readonly quietHours: RoutineTimeWindow | null;
  /** The zone `quietHours` is wall-clock in. */
  readonly timezone: string;
  /** When the soft-reminder half was last written. Absent until it is. */
  readonly updatedAt?: string;
}

/** What a client may send. Every field optional: the screen has three controls. */
export interface ReminderSettingsInput {
  readonly softEnabled?: boolean;
  readonly softLeadMinutes?: number;
  /** Present means "set them to this"; `null` means "I have none". */
  readonly quietHours?: RoutineTimeWindow | null;
  /** Required whenever `quietHours` is present: a window with no zone is not a time. */
  readonly timezone?: string;
}

export class ReminderSettingsValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(`reminder settings: ${message}`);
    this.name = 'ReminderSettingsValidationError';
  }
}

function fail(message: string, reason: string): never {
  throw new ReminderSettingsValidationError(message, reason);
}

/** The half that lives on the user document. Deliberately two fields wide. */
interface StoredReminderSettings {
  softEnabled: boolean;
  softLeadMinutes: number;
  updatedAt: string;
}

interface ReminderSettingsBearingUser {
  reminderSettings?: StoredReminderSettings;
  timezone?: string | null;
}

export interface ReminderSettingsOptions {
  storage?: StorageAdapter;
}

function storageOf(options: ReminderSettingsOptions): StorageAdapter {
  return options.storage ?? getStorage();
}

/** A stored record that is not readable reads as the defaults, not as half of one. */
function readStored(value: unknown): StoredReminderSettings | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.softEnabled !== 'boolean') return null;
  if (typeof raw.softLeadMinutes !== 'number' || !SOFT_LEAD_MINUTES.includes(raw.softLeadMinutes)) return null;
  return {
    softEnabled: raw.softEnabled,
    softLeadMinutes: raw.softLeadMinutes,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
  };
}

export async function readReminderSettings(
  uid: string,
  options: ReminderSettingsOptions = {},
): Promise<ReminderSettings> {
  requireUserId(uid);
  const storage = storageOf(options);
  const user = await storage.get<ReminderSettingsBearingUser>(userDoc(uid));
  const stored = readStored(user?.reminderSettings);
  const profile = await readRoutineProfile(uid, { storage });

  return Object.freeze({
    softEnabled: stored?.softEnabled ?? DEFAULT_SOFT_ENABLED,
    softLeadMinutes: stored?.softLeadMinutes ?? DEFAULT_SOFT_LEAD_MINUTES,
    quietHours: profile?.quietHours ?? null,
    timezone: profile?.timezone
      ?? (typeof user?.timezone === 'string' && user.timezone ? user.timezone : 'UTC'),
    ...(stored?.updatedAt ? { updatedAt: stored.updatedAt } : {}),
  });
}

/**
 * Records the settings and returns what the account now holds.
 *
 * `at` is the caller's, so the stored `updatedAt`, the profile's `updatedAt`
 * and every fact's `observedAt` are one instant rather than three racing
 * `new Date()`s — the same reason `saveRoutineProfile` takes one.
 */
export async function saveReminderSettings(
  uid: string,
  input: ReminderSettingsInput,
  at: string,
  options: ReminderSettingsOptions = {},
): Promise<ReminderSettings> {
  requireUserId(uid);
  const storage = storageOf(options);
  const current = await readReminderSettings(uid, { storage });

  if (input.softEnabled !== undefined && typeof input.softEnabled !== 'boolean') {
    fail('softEnabled must be a boolean', 'invalid_soft_enabled');
  }
  if (input.softLeadMinutes !== undefined && !SOFT_LEAD_MINUTES.includes(input.softLeadMinutes)) {
    fail(`softLeadMinutes must be one of ${SOFT_LEAD_MINUTES.join(', ')}`, 'invalid_lead_minutes');
  }

  const next: StoredReminderSettings = {
    softEnabled: input.softEnabled ?? current.softEnabled,
    softLeadMinutes: input.softLeadMinutes ?? current.softLeadMinutes,
    updatedAt: at,
  };

  await storage.runTransaction(async (tx) => {
    await tx.get<ReminderSettingsBearingUser>(userDoc(uid));
    tx.merge<ReminderSettingsBearingUser>(userDoc(uid), { reminderSettings: next });
  });

  if (input.quietHours !== undefined) {
    await writeQuietHoursThrough(uid, input, at, { storage });
  }

  return readReminderSettings(uid, { storage });
}

/**
 * Puts quiet hours where they already live, through the survey's own writer.
 *
 * Every other answer on the profile is carried across untouched, so editing
 * quiet hours from the reminders screen cannot erase the sleep or focus hours
 * somebody gave the survey.
 */
async function writeQuietHoursThrough(
  uid: string,
  input: ReminderSettingsInput,
  at: string,
  options: ReminderSettingsOptions,
): Promise<void> {
  const storage = storageOf(options);
  const existing = await readRoutineProfile(uid, { storage });
  const timezone = input.timezone ?? existing?.timezone;
  if (!isValidTimezone(timezone)) {
    fail('timezone must be an IANA zone id when quietHours is sent', 'invalid_timezone');
  }

  const base: Omit<UserRoutineProfile, 'schemaVersion' | 'updatedAt'> = existing ?? {
    timezone,
    sleepWindow: null,
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: null,
    surveySkipped: false,
  };

  // Round-tripped through the profile's own parser rather than assembled here,
  // so a malformed `quietHours` is refused by the validator that already knows
  // what a window is — including the zero-length window it rejects.
  let profileInput: RoutineProfileInput;
  try {
    profileInput = parseRoutineProfileInput({
      ...buildRoutineProfile({ ...base, timezone }, at),
      timezone,
      quietHours: input.quietHours ?? null,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : 'quietHours is not a window', 'invalid_quiet_hours');
  }

  await saveRoutineProfile(uid, profileInput, at, {
    storage,
    reasonCode: 'reminder_settings_saved',
  });
}

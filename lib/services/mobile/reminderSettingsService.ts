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
import {
  DEFAULT_PRESSURE_CEILING,
  normalizePressureCeiling,
  type PressureCeiling,
} from '../pressureService';

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
  /**
   * Whether a Must commitment may ring (UC-3.12a, #197). Off unless the user
   * turned it on, or answered the old Flutter survey with the strong option —
   * see `legacyHardSettings`.
   */
  readonly hardEnabled: boolean;
  /** The strongest stage this account agreed to. The #199 ceiling, as stored. */
  readonly escalationCeiling: PressureCeiling;
  /** Whether the Must stage — and only that stage — may ring inside quiet hours. */
  readonly mustThroughQuietHours: boolean;
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
  readonly hardEnabled?: boolean;
  readonly escalationCeiling?: PressureCeiling;
  readonly mustThroughQuietHours?: boolean;
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

/**
 * The half that lives on the user document.
 *
 * The three #197 fields are optional *in storage*, because every document
 * written before #197 lacks them and an absent field has a meaning — "never
 * chosen", which `legacyHardSettings` answers — that a defaulted `false` would
 * erase.
 */
interface StoredReminderSettings {
  softEnabled: boolean;
  softLeadMinutes: number;
  hardEnabled?: boolean;
  escalationCeiling?: PressureCeiling;
  mustThroughQuietHours?: boolean;
  updatedAt: string;
}

/**
 * What an account that never saw the #197 controls gets (UC-3.12a, #197 step 1).
 *
 * The Flutter client had no switch for the strong stage: answering the routine
 * survey with `strongReminder` *was* the opt-in
 * (`routine_profile_notifier.dart:95-96` on `archive/flutter-final`). So that
 * answer maps to hard reminders on with a hard ceiling, `followUp` keeps the
 * follow-up it already gets, and everything else — including no profile at
 * all — is the gentlest ceiling with hard reminders off.
 *
 * Only ever applied to a field that is *absent*. The moment the user touches
 * the new control their answer is stored and this stops being consulted, so a
 * survey answer can never override a choice made on the settings screen.
 */
export function legacyHardSettings(intensity: unknown): {
  hardEnabled: boolean;
  escalationCeiling: PressureCeiling;
} {
  if (intensity === 'strongReminder') return { hardEnabled: true, escalationCeiling: 'hard' };
  if (intensity === 'followUp') return { hardEnabled: false, escalationCeiling: 'followUp' };
  return { hardEnabled: false, escalationCeiling: DEFAULT_PRESSURE_CEILING };
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

/**
 * The #197 fields, read on their own so a record whose soft half is unreadable
 * does not also forget a choice the user made about ringing.
 *
 * `hardEnabled` of the wrong type reads as absent, never as `true`. And a
 * ceiling that is *present* but off the whitelist is the gentlest one (#199's
 * `normalizePressureCeiling`), not "absent" — absent falls back to the survey,
 * which could come out louder than what the document was trying to say.
 */
function readStoredHard(value: unknown): Pick<StoredReminderSettings, 'hardEnabled' | 'escalationCeiling' | 'mustThroughQuietHours'> {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  return {
    ...(typeof raw.hardEnabled === 'boolean' ? { hardEnabled: raw.hardEnabled } : {}),
    ...(raw.escalationCeiling === undefined
      ? {}
      : { escalationCeiling: normalizePressureCeiling(raw.escalationCeiling) }),
    ...(typeof raw.mustThroughQuietHours === 'boolean'
      ? { mustThroughQuietHours: raw.mustThroughQuietHours }
      : {}),
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
  const hard = readStoredHard(user?.reminderSettings);
  const profile = await readRoutineProfile(uid, { storage });
  const legacy = legacyHardSettings(profile?.preferredReminderIntensity);

  return Object.freeze({
    softEnabled: stored?.softEnabled ?? DEFAULT_SOFT_ENABLED,
    softLeadMinutes: stored?.softLeadMinutes ?? DEFAULT_SOFT_LEAD_MINUTES,
    hardEnabled: hard.hardEnabled ?? legacy.hardEnabled,
    escalationCeiling: hard.escalationCeiling ?? legacy.escalationCeiling,
    mustThroughQuietHours: hard.mustThroughQuietHours ?? false,
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

  if (input.hardEnabled !== undefined && typeof input.hardEnabled !== 'boolean') {
    fail('hardEnabled must be a boolean', 'invalid_hard_enabled');
  }
  if (
    input.escalationCeiling !== undefined
    && input.escalationCeiling !== 'soft'
    && input.escalationCeiling !== 'followUp'
    && input.escalationCeiling !== 'hard'
  ) {
    // Refused rather than normalised: `normalizePressureCeiling` is for a
    // stored value nobody is present to correct. A client sending a word we do
    // not know is told so.
    fail('escalationCeiling must be one of soft, followUp, hard', 'invalid_escalation_ceiling');
  }
  if (input.mustThroughQuietHours !== undefined && typeof input.mustThroughQuietHours !== 'boolean') {
    fail('mustThroughQuietHours must be a boolean', 'invalid_must_through_quiet_hours');
  }

  /*
   * All three #197 fields are written on every save, including a save that only
   * moved the lead time. `current` has already resolved them — the stored
   * choice, or the survey's legacy answer — so writing them freezes that answer
   * at the moment the user first used this screen. Leaving them absent would
   * let a later survey edit silently turn ringing on for somebody who had
   * already been shown the control and left it alone.
   */
  const next: StoredReminderSettings = {
    softEnabled: input.softEnabled ?? current.softEnabled,
    softLeadMinutes: input.softLeadMinutes ?? current.softLeadMinutes,
    hardEnabled: input.hardEnabled ?? current.hardEnabled,
    escalationCeiling: input.escalationCeiling ?? current.escalationCeiling,
    mustThroughQuietHours: input.mustThroughQuietHours ?? current.mustThroughQuietHours,
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
  /*
   * The profile's own zone wins once it has one, and the body's is used only
   * to create the first profile.
   *
   * It was the other way round, and that let this endpoint move the *whole*
   * profile: `timezone` is the zone `sleepWindow` and `focusWindows` are
   * wall-clock in, so a reminders screen that sent `Europe/Berlin` with a quiet
   * window silently shifted the sleep hours the routine survey had stored. The
   * screen normally sends the profile's own zone back, so this only bites when
   * it has fallen through to the device's — which is exactly the case where the
   * profile is the better authority.
   *
   * Changing the zone of an existing profile is the routine survey's job, which
   * is where the user can see the other windows it moves.
   */
  const timezone = existing?.timezone ?? input.timezone;
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

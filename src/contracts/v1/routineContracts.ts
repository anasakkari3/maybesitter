/**
 * The routine profile, as the account holds it (UC-2.7a, #167).
 *
 * ── Windows, not enum answers ────────────────────────────────────
 *
 * The survey asks five multiple-choice questions, but what it stores is the
 * *time windows* those choices stand for — `{ start: '22:30', end: '07:30' }`
 * rather than `'standard'`. That is the Flutter client's shape
 * (`UserRoutineProfile.toJson()`, preserved on `archive/flutter-final`) and it
 * is kept deliberately:
 *
 *  - UC-2.9 (#170) needs a concrete focus window and concrete quiet hours to
 *    decide whether to show a card at 23:00. An enum would make every consumer
 *    re-derive the same table, and they would drift.
 *  - The choice list is a client presentation detail. Re-labelling
 *    "standard" or adding a sixth option must not invalidate profiles already
 *    stored, and with windows it does not.
 *
 * The client maps a stored window back to the chip it should highlight, which
 * is how the Flutter survey already re-opened a saved profile.
 *
 * ── Local time, with the zone beside it ──────────────────────────
 *
 * `start`/`end` are wall-clock `HH:MM` in the profile's own `timezone`, never
 * instants. "I sleep at 22:30" stays true after the user flies to Berlin and
 * after a daylight-saving change; an instant would silently mean something
 * else on both. A window whose `end` is not after its `start` wraps midnight,
 * which is the normal case for sleep and quiet hours.
 */

/** IANA zone ids only; validated with `Intl` rather than a list. */
export const ROUTINE_PROFILE_SCHEMA_VERSION = 1 as const;

/** The survey version recorded as `provenance.originRef` on its facts. */
export const ROUTINE_SURVEY_VERSION = 'routine-survey-v1';

export type ReminderIntensity = 'none' | 'softAwareness' | 'followUp' | 'strongReminder';

export const REMINDER_INTENSITIES: readonly ReminderIntensity[] = [
  'none',
  'softAwareness',
  'followUp',
  'strongReminder',
];

/**
 * A recurring wall-clock window. `label` is a machine tag the survey attaches
 * to focus and fixed-commitment windows (`work_study`, `fixed_commitments`);
 * it is never shown to anyone and never free text from the user.
 */
export interface RoutineTimeWindow {
  readonly start: string;
  readonly end: string;
  readonly label?: string;
}

export interface UserRoutineProfile {
  readonly schemaVersion: typeof ROUTINE_PROFILE_SCHEMA_VERSION;
  readonly updatedAt: string;
  readonly timezone: string;
  readonly sleepWindow: RoutineTimeWindow | null;
  readonly focusWindows: readonly RoutineTimeWindow[];
  readonly fixedCommitmentWindows: readonly RoutineTimeWindow[];
  readonly preferredReminderIntensity: ReminderIntensity;
  readonly quietHours: RoutineTimeWindow | null;
  /**
   * The user reached the survey and chose not to answer it. Distinct from
   * "never saw it": a skip is an answer, and the app must not ask again.
   */
  readonly surveySkipped: boolean;
}

/** What a client may send. `updatedAt` is the server's to set, never the caller's. */
export type RoutineProfileInput = Omit<UserRoutineProfile, 'schemaVersion' | 'updatedAt'>;

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** The longest label the survey emits is `fixed_commitments`; this is generous. */
const LABEL = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_WINDOWS = 8;

export class RoutineProfileValidationError extends Error {
  constructor(message: string) {
    super(`routine profile: ${message}`);
    this.name = 'RoutineProfileValidationError';
  }
}

function fail(message: string): never {
  throw new RoutineProfileValidationError(message);
}

/** True for a zone `Intl` can actually format in; a list would go stale. */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseWindow(value: unknown, label: string): RoutineTimeWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.start !== 'string' || !HHMM.test(raw.start)) fail(`${label}.start must be HH:MM`);
  if (typeof raw.end !== 'string' || !HHMM.test(raw.end)) fail(`${label}.end must be HH:MM`);
  // A zero-length window is almost certainly a client bug, and it would make
  // "inside the focus window" false for every instant — a silent feature-off.
  if (raw.start === raw.end) fail(`${label} starts and ends at the same minute`);
  if (raw.label !== undefined && raw.label !== null
    && (typeof raw.label !== 'string' || !LABEL.test(raw.label))) {
    fail(`${label}.label must match ${String(LABEL)}`);
  }
  return Object.freeze({
    start: raw.start,
    end: raw.end,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  });
}

function parseWindowList(value: unknown, label: string): readonly RoutineTimeWindow[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > MAX_WINDOWS) fail(`${label} may hold at most ${MAX_WINDOWS} windows`);
  return Object.freeze(value.map((entry, index) => parseWindow(entry, `${label}[${index}]`)));
}

function parseOptionalWindow(value: unknown, label: string): RoutineTimeWindow | null {
  return value === undefined || value === null ? null : parseWindow(value, label);
}

/**
 * Validates a client body into a profile input.
 *
 * Rejects rather than coerces, for the same reason the memory store does: a
 * silently dropped quiet-hours window means notifications at 3am, and the user
 * would have no way to tell that their answer never arrived.
 */
export function parseRoutineProfileInput(value: unknown): RoutineProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('body must be an object');
  const raw = value as Record<string, unknown>;

  if (!isValidTimezone(raw.timezone)) fail('timezone must be an IANA zone id');

  const intensity = raw.preferredReminderIntensity ?? 'softAwareness';
  if (!REMINDER_INTENSITIES.includes(intensity as ReminderIntensity)) {
    fail(`preferredReminderIntensity must be one of ${REMINDER_INTENSITIES.join(', ')}`);
  }

  if (raw.surveySkipped !== undefined && typeof raw.surveySkipped !== 'boolean') {
    fail('surveySkipped must be a boolean');
  }

  return Object.freeze({
    timezone: raw.timezone,
    sleepWindow: parseOptionalWindow(raw.sleepWindow, 'sleepWindow'),
    focusWindows: parseWindowList(raw.focusWindows, 'focusWindows'),
    fixedCommitmentWindows: parseWindowList(raw.fixedCommitmentWindows, 'fixedCommitmentWindows'),
    preferredReminderIntensity: intensity as ReminderIntensity,
    quietHours: parseOptionalWindow(raw.quietHours, 'quietHours'),
    surveySkipped: raw.surveySkipped === true,
  });
}

/** Stamps the server-owned fields onto a validated input. */
export function buildRoutineProfile(input: RoutineProfileInput, updatedAt: string): UserRoutineProfile {
  return Object.freeze({
    schemaVersion: ROUTINE_PROFILE_SCHEMA_VERSION,
    updatedAt,
    timezone: input.timezone,
    sleepWindow: input.sleepWindow,
    focusWindows: Object.freeze([...input.focusWindows]),
    fixedCommitmentWindows: Object.freeze([...input.fixedCommitmentWindows]),
    preferredReminderIntensity: input.preferredReminderIntensity,
    quietHours: input.quietHours,
    surveySkipped: input.surveySkipped,
  });
}

/** Shape guard for a document read back, so a hand-edited one is skipped. */
export function isUserRoutineProfile(value: unknown): value is UserRoutineProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== ROUTINE_PROFILE_SCHEMA_VERSION) return false;
  if (typeof raw.updatedAt !== 'string' || raw.updatedAt === '') return false;
  if (!isValidTimezone(raw.timezone)) return false;
  if (!REMINDER_INTENSITIES.includes(raw.preferredReminderIntensity as ReminderIntensity)) return false;
  if (typeof raw.surveySkipped !== 'boolean') return false;
  try {
    parseOptionalWindow(raw.sleepWindow, 'sleepWindow');
    parseOptionalWindow(raw.quietHours, 'quietHours');
    parseWindowList(raw.focusWindows, 'focusWindows');
    parseWindowList(raw.fixedCommitmentWindows, 'fixedCommitmentWindows');
  } catch {
    return false;
  }
  return true;
}

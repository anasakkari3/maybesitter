/**
 * What `/api/mobile/habits/**` is allowed to say and to be told (#520).
 *
 * The four route files are thin; every decision that matters lives here, so
 * that "what a client may configure" is one readable list rather than four
 * handlers that each remember most of it. This is `lib/watchers/watcherApi.ts`'s
 * shape, on purpose — the two are the same kind of boundary, and a second
 * spelling of "refuse unknown keys" is how two boundaries come to refuse
 * different things.
 *
 * ── The body cannot choose the tree or the identity ──────────────
 *
 * `parseNewHabit` returns a `NewHabitInput`, whose type carries no `scopeId`,
 * no `habitId` and no timestamps: the uid comes from the verified token and the
 * id is minted by the store. There is no field a request can set that names
 * another account's tree.
 *
 * ── Unknown keys are refused ─────────────────────────────────────
 *
 * A body carrying a key this module does not know is a 400, not a silent drop.
 * The failure being avoided is the client that sets `maxShiftMinutes: 30`, gets
 * a 201, and is never told the habit it created has no bound on how far it
 * moves.
 *
 * ── Every bound here is a real one ───────────────────────────────
 *
 * The numeric limits below are not decoration. `preferredWindows` and
 * `weekdays` are caller-sized arrays that the adapter sorts and materializes
 * once per occurrence per day, and #508 is this repo's standing lesson that a
 * client-side length limit is not a limit: the server caps them.
 */
import type { MinuteOfDay } from '../../src/contracts/v1/planningContracts';
import { MINUTES_PER_DAY } from '../../src/contracts/v1/planningContracts';
import type {
  HabitCadence,
  HabitDefinition,
  HabitOccurrence,
  TimeWindow,
} from './habitTypes';
import type { HabitPatch, NewHabitInput } from './habitStore';

export class HabitValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'HabitValidationError';
  }
}

export function habitValidationResponse(error: HabitValidationError): Response {
  return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
}

/** The store mints these; nothing else is an id this API will look up. */
const HABIT_ID = /^hbt_[0-9a-fA-F-]{36}$/;
const OCCURRENCE_ID = /^hbo_[0-9a-fA-F-]{36}$/;

export const HABIT_TITLE_MAX = 200;
/** A day has 1440 minutes; a habit that fills one is already the whole day. */
export const HABIT_DURATION_MAX = MINUTES_PER_DAY;
/** Enough for "mornings, lunchtime, evenings" several times over, and bounded. */
export const PREFERRED_WINDOWS_MAX = 8;
/** A period is a week in v1, so more than one occurrence a day is the ceiling. */
export const OCCURRENCES_MAX = 31;

const NEW_KEYS = new Set([
  'title', 'cadence', 'durationMinutes', 'preferredWindows',
  'minimumOccurrences', 'maximumOccurrences', 'flexibility', 'recoveryPolicy', 'status', 'source',
]);
/**
 * `source` is absent from the patch keys, and that is the point of the two
 * lists differing. A habit created from a confirmed goal was created from a
 * confirmed goal for ever; letting a PATCH restate it would let a client
 * relabel its own guesses as things the user agreed to, which is the provenance
 * every other confirmation boundary in this repo protects.
 */
const PATCH_KEYS = new Set(Array.from(NEW_KEYS).filter((key) => key !== 'source'));
const WINDOW_KEYS = new Set(['startMinute', 'endMinute']);

const FLEXIBILITIES = ['flexible', 'protected_flexible'] as const;
const RECOVERY_POLICIES = ['skip', 'retry_same_day', 'recover_within_period'] as const;
const STATUSES = ['active', 'paused', 'archived'] as const;
const SOURCES = ['user_created', 'goal_confirmed', 'onboarding_confirmed'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknown(body: Record<string, unknown>, allowed: Set<string>, where: string): void {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new HabitValidationError(`${where} does not accept "${key}"`, 'unknown_field');
    }
  }
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
    throw new HabitValidationError(`${field} must be one of ${allowed.join(', ')}`, `invalid_${field}`);
  }
  return raw as T;
}

function wholeNumber(raw: unknown, field: string, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    throw new HabitValidationError(`${field} must be a whole number between ${min} and ${max}`, `invalid_${field}`);
  }
  return raw;
}

/** `hbt_<uuid>` and nothing else, checked before any read so a path segment cannot be a probe. */
export function parseHabitId(raw: unknown): string {
  if (typeof raw !== 'string' || !HABIT_ID.test(raw)) {
    throw new HabitValidationError('not a habit id', 'invalid_habit_id');
  }
  return raw;
}

export function parseOccurrenceId(raw: unknown): string {
  if (typeof raw !== 'string' || !OCCURRENCE_ID.test(raw)) {
    throw new HabitValidationError('not an occurrence id', 'invalid_occurrence_id');
  }
  return raw;
}

function parseTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new HabitValidationError('title must be a string', 'invalid_title');
  const title = raw.trim();
  if (title.length === 0 || title.length > HABIT_TITLE_MAX) {
    throw new HabitValidationError(`title must be between 1 and ${HABIT_TITLE_MAX} characters`, 'invalid_title');
  }
  return title;
}

function parseCadence(raw: unknown): HabitCadence {
  if (!isRecord(raw)) throw new HabitValidationError('cadence must be an object', 'invalid_cadence');
  if (raw.kind === 'weekly_count') {
    refuseUnknown(raw, new Set(['kind', 'count']), 'a weekly_count cadence');
    return { kind: 'weekly_count', count: wholeNumber(raw.count, 'cadence.count', 1, 7) };
  }
  if (raw.kind === 'weekdays') {
    refuseUnknown(raw, new Set(['kind', 'weekdays']), 'a weekdays cadence');
    if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0 || raw.weekdays.length > 7) {
      throw new HabitValidationError('cadence.weekdays must be 1 to 7 weekdays', 'invalid_cadence');
    }
    const weekdays = raw.weekdays.map((day) => wholeNumber(day, 'cadence.weekdays', 0, 6));
    if (new Set(weekdays).size !== weekdays.length) {
      // A repeated weekday is a request for two occurrences on one day, which
      // is not what it says and is not what materialization would do with it.
      throw new HabitValidationError('cadence.weekdays must not repeat a day', 'invalid_cadence');
    }
    return { kind: 'weekdays', weekdays };
  }
  throw new HabitValidationError('cadence.kind must be "weekly_count" or "weekdays"', 'invalid_cadence');
}

function parseWindow(raw: unknown): TimeWindow {
  if (!isRecord(raw)) throw new HabitValidationError('a preferred window must be an object', 'invalid_preferred_windows');
  refuseUnknown(raw, WINDOW_KEYS, 'a preferred window');
  const startMinute: MinuteOfDay = wholeNumber(raw.startMinute, 'startMinute', 0, MINUTES_PER_DAY);
  const endMinute: MinuteOfDay = wholeNumber(raw.endMinute, 'endMinute', 0, MINUTES_PER_DAY);
  if (endMinute <= startMinute) {
    // `endMinute` is exclusive, so an equal pair is a window of no length. It
    // is refused here rather than dropped by the adapter, because a client that
    // sent one believes it stated a preference.
    throw new HabitValidationError('a preferred window must end after it starts', 'invalid_preferred_windows');
  }
  return { startMinute, endMinute };
}

function parsePreferredWindows(raw: unknown): readonly TimeWindow[] {
  if (!Array.isArray(raw) || raw.length > PREFERRED_WINDOWS_MAX) {
    throw new HabitValidationError(`preferredWindows must be an array of at most ${PREFERRED_WINDOWS_MAX}`, 'invalid_preferred_windows');
  }
  return raw.map(parseWindow);
}

/**
 * The occurrence counts, checked as a pair.
 *
 * Separately they are two numbers in range; together they are a statement that
 * has to be satisfiable. A minimum above the maximum is a habit materialization
 * can never get right, and it would fail silently — every week either short of
 * the floor or over the ceiling, with nothing to point at.
 */
function parseOccurrenceBounds(
  rawMinimum: unknown,
  rawMaximum: unknown,
): { minimumOccurrences: number; maximumOccurrences: number } {
  const minimumOccurrences = wholeNumber(rawMinimum, 'minimumOccurrences', 0, OCCURRENCES_MAX);
  const maximumOccurrences = wholeNumber(rawMaximum, 'maximumOccurrences', 1, OCCURRENCES_MAX);
  if (minimumOccurrences > maximumOccurrences) {
    throw new HabitValidationError('minimumOccurrences cannot exceed maximumOccurrences', 'invalid_occurrence_bounds');
  }
  return { minimumOccurrences, maximumOccurrences };
}

export function parseNewHabit(body: unknown): NewHabitInput {
  if (!isRecord(body)) throw new HabitValidationError('body must be an object', 'invalid_body');
  refuseUnknown(body, NEW_KEYS, 'a habit');

  const { minimumOccurrences, maximumOccurrences } = parseOccurrenceBounds(
    body.minimumOccurrences ?? 1,
    body.maximumOccurrences ?? 7,
  );
  return {
    title: parseTitle(body.title),
    cadence: parseCadence(body.cadence),
    durationMinutes: wholeNumber(body.durationMinutes, 'durationMinutes', 1, HABIT_DURATION_MAX),
    preferredWindows: parsePreferredWindows(body.preferredWindows ?? []),
    minimumOccurrences,
    maximumOccurrences,
    // Flexible unless the user said otherwise: a habit the planner may move is
    // the safe default, and `protected_flexible` is a claim on an hour of
    // somebody's day that they should have to make.
    flexibility: oneOf(body.flexibility ?? 'flexible', FLEXIBILITIES, 'flexibility'),
    recoveryPolicy: oneOf(body.recoveryPolicy ?? 'skip', RECOVERY_POLICIES, 'recoveryPolicy'),
    status: oneOf(body.status ?? 'active', STATUSES, 'status'),
    source: oneOf(body.source ?? 'user_created', SOURCES, 'source'),
  };
}

/**
 * What a PATCH may change: everything about the habit except where it came
 * from and who it belongs to. See `PATCH_KEYS`.
 *
 * The occurrence bounds are the one pair that cannot be validated field by
 * field. A patch that moves only the minimum is still checked against the
 * stored maximum — which is why this takes the current habit, and why a patch
 * validated in isolation would let two individually legal edits leave a habit
 * that can never be materialized.
 */
export function parseHabitPatch(body: unknown, current: HabitDefinition): HabitPatch {
  if (!isRecord(body)) throw new HabitValidationError('body must be an object', 'invalid_body');
  refuseUnknown(body, PATCH_KEYS, 'a habit patch');
  if (Object.keys(body).length === 0) {
    throw new HabitValidationError('nothing to change', 'empty_patch');
  }
  if (body.minimumOccurrences !== undefined || body.maximumOccurrences !== undefined) {
    parseOccurrenceBounds(
      body.minimumOccurrences ?? current.minimumOccurrences,
      body.maximumOccurrences ?? current.maximumOccurrences,
    );
  }
  return {
    ...(body.title === undefined ? {} : { title: parseTitle(body.title) }),
    ...(body.cadence === undefined ? {} : { cadence: parseCadence(body.cadence) }),
    ...(body.durationMinutes === undefined ? {} : { durationMinutes: wholeNumber(body.durationMinutes, 'durationMinutes', 1, HABIT_DURATION_MAX) }),
    ...(body.preferredWindows === undefined ? {} : { preferredWindows: parsePreferredWindows(body.preferredWindows) }),
    ...(body.minimumOccurrences === undefined ? {} : { minimumOccurrences: body.minimumOccurrences as number }),
    ...(body.maximumOccurrences === undefined ? {} : { maximumOccurrences: body.maximumOccurrences as number }),
    ...(body.flexibility === undefined ? {} : { flexibility: oneOf(body.flexibility, FLEXIBILITIES, 'flexibility') }),
    ...(body.recoveryPolicy === undefined ? {} : { recoveryPolicy: oneOf(body.recoveryPolicy, RECOVERY_POLICIES, 'recoveryPolicy') }),
    ...(body.status === undefined ? {} : { status: oneOf(body.status, STATUSES, 'status') }),
  };
}

/* ── Presentation ────────────────────────────────────────────────── */

/**
 * One habit as the client reads it.
 *
 * The whole definition including `scopeId`'s absence: the client already knows
 * whose account it is asking about, and echoing the uid into every row of a
 * list response puts an account identifier on the wire once per habit for no
 * reader that needs it.
 */
export function presentHabit(definition: HabitDefinition) {
  return {
    habitId: definition.habitId,
    title: definition.title,
    cadence: definition.cadence,
    durationMinutes: definition.durationMinutes,
    preferredWindows: definition.preferredWindows,
    minimumOccurrences: definition.minimumOccurrences,
    maximumOccurrences: definition.maximumOccurrences,
    flexibility: definition.flexibility,
    recoveryPolicy: definition.recoveryPolicy,
    status: definition.status,
    source: definition.source,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
  };
}

export function presentOccurrence(occurrence: HabitOccurrence) {
  return {
    occurrenceId: occurrence.occurrenceId,
    habitId: occurrence.habitId,
    localDate: occurrence.localDate,
    state: occurrence.state,
    durationMinutes: occurrence.durationMinutes,
  };
}

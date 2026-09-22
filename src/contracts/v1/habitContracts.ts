/**
 * A Habit: executable demand on future time (#520).
 *
 * ── Not the Routine Profile ──────────────────────────────────────
 *
 * `routineContracts.ts` describes the *person* — when they sleep, when they
 * focus, when they must not be disturbed. Nothing in it asks for time; it only
 * tells a planner what the person's day already looks like.
 *
 * A Habit is the other thing. "Gym three times a week" is not a fact about
 * somebody's week, it is a claim on it: three blocks that do not exist yet and
 * that something has to find room for. Keeping the two apart is the whole
 * reason this file exists — a profile field that quietly started asking for
 * time would be a planner allocating hours nobody agreed to.
 *
 * ── Bounded, always ──────────────────────────────────────────────
 *
 * A Habit is a rule, and a rule has no end. What the rest of the system sees
 * is never the rule but `HabitOccurrence`s materialized over a horizon at most
 * `HABIT_HORIZON_MAX_DAYS` long. There is no code path from a Habit to an
 * unbounded set of anything: `materializeHabitOccurrences` refuses a horizon
 * wider than the maximum rather than truncating it, because a truncated
 * horizon is a caller who asked for a year and silently got eight weeks.
 *
 * ── Civil dates, not instants ────────────────────────────────────
 *
 * `localDate` is a `YYYY-MM-DD` civil date and nothing here converts one to an
 * instant. That is deliberate and it is what makes the DST acceptance
 * criterion hold by construction: a habit's demand is "a gym session on
 * Wednesday", and Wednesday is still exactly one day long on the two dates a
 * year the offset moves. The translation from a demand date to an actual
 * interval in a zone belongs to the adapter, which has `lib/planning/shared/
 * time.ts` for it — the one place in this repo allowed to do DST arithmetic.
 *
 * ── Confirmation is structural ───────────────────────────────────
 *
 * The critical invariant of #520 is that goal or memory text never becomes a
 * Habit on its own. That is not enforced by a rule somebody has to remember:
 * `confirmation` is non-optional on every `HabitDefinition`, it carries the
 * instant a person pressed something, and `parseHabitDefinitionInput` refuses
 * a body without it. A model can produce a `HabitProposal` — which has no id,
 * no status, and no place to be stored as a habit — and nothing else.
 *
 * ── What is not here ─────────────────────────────────────────────
 *
 * No streak, no chain, no penalty, no score, and no field a completion could
 * increment. A skipped occurrence is a date that did not happen; the only
 * thing the product does with it is what `recoveryPolicy` says, and the widest
 * of those is "offer another date this week". `tests/habits/habitBoundaries.
 * test.ts` asserts the vocabulary, because the field that would carry this is
 * always added in good faith.
 */

import type { RoutineTimeWindow } from './routineContracts';

export const HABIT_SCHEMA_VERSION = 1 as const;

/**
 * The widest horizon `materializeHabitOccurrences` will accept, in days.
 *
 * Eight weeks. Long enough that a weekly cadence has a period to recover
 * inside even at the far edge, short enough that a materialization is a page
 * of rows rather than a year of them. The number matters less than the fact
 * that there is one: this constant is the "a Habit never becomes an infinite
 * set of Commitments" criterion, stated where it is enforced.
 */
export const HABIT_HORIZON_MAX_DAYS = 56;

/**
 * Monday. The period a `weekly_count` counts inside, and the period a
 * `recover_within_period` recovery may not leave.
 *
 * Fixed rather than configurable, and ISO rather than the locale's week start,
 * because the two ends of this have to agree: if materialization counted a
 * Sunday-start week and recovery a Monday-start one, a Sunday skip would
 * recover into a week that already had its three sessions, and both sides
 * would be self-consistent about it.
 */
export const HABIT_PERIOD_START_WEEKDAY = 1 as const;

/** The most times a week a habit may be asked for. One per day is the ceiling. */
export const HABIT_MAX_OCCURRENCES_PER_PERIOD = 7;

/** Longest single occurrence, in minutes. Eight hours; a longer one is a typo or a job. */
export const HABIT_MAX_DURATION_MINUTES = 480;

export const HABIT_MAX_PREFERRED_WINDOWS = 4;

export const HABIT_MAX_TITLE_LENGTH = 120;

/**
 * A preferred wall-clock window, structurally the routine profile's.
 *
 * The same type on purpose: a focus window the person already told the survey
 * about is exactly what "I'd rather do this in the morning" means, and the two
 * being one type is what lets a client hand one straight to the other. Like
 * there, `start`/`end` are `HH:MM` in the user's own zone and never instants,
 * and an `end` not after `start` wraps midnight.
 */
export type HabitTimeWindow = RoutineTimeWindow;

/**
 * How often, in one of the only two shapes a person actually states.
 *
 * `weekly_count` is "three times a week" — the count is the demand and the
 * days are the system's to choose (see `canonicalWeekOffsets`). `weekdays` is
 * "Monday, Wednesday, Friday" — the days are the demand and there is nothing
 * to choose. A single union rather than one nullable shape with both fields,
 * so there is no value that means both or neither.
 */
export type HabitCadence =
  | { readonly kind: 'weekly_count'; readonly count: number }
  | { readonly kind: 'weekdays'; readonly weekdays: readonly number[] };

/**
 * How hard the occurrence holds its place once the planner puts it somewhere.
 *
 * These are the two `TimeOwnership` values a habit can legitimately ask for.
 * `fixed` is deliberately absent: a habit is a rule about a week, not an
 * appointment with anyone, and a rule that could pin an immovable block would
 * be able to push a real commitment out of the day.
 */
export type HabitFlexibility = 'flexible' | 'protected_flexible';

/**
 * What happens to a date that did not happen.
 *
 * `skip` lets it go. `retry_same_day` offers the same date again — for the
 * habit whose point is the day ("take the medication"). `recover_within_period`
 * offers a later date in the same week, which is the only one of the three that
 * can create an occurrence the cadence did not originally ask for, and it is
 * bounded by `maximumOccurrences` for exactly that reason.
 *
 * None of the three is a judgement about the person, and none of them is
 * applied automatically to anything the user has not configured.
 */
export type HabitRecoveryPolicy = 'skip' | 'retry_same_day' | 'recover_within_period';

/**
 * `paused` stops future demand and keeps every occurrence already recorded;
 * `archived` is the user putting it away. Neither deletes history — see
 * `materializeHabitOccurrences`, which drops only unstarted `pending` rows.
 */
export type HabitStatus = 'active' | 'paused' | 'archived';

/**
 * Where the habit came from, and all three are things a person did.
 *
 * `goal_confirmed` and `onboarding_confirmed` name the *screen* the
 * confirmation happened on, not a degree of automation: both of them still
 * required the person to accept a cadence and a duration, and neither can be
 * reached without a `HabitConfirmation`.
 */
export type HabitSource = 'user_created' | 'goal_confirmed' | 'onboarding_confirmed';

/**
 * The receipt for the act that created this habit.
 *
 * Non-optional, which is the point. There is no `HabitDefinition` without an
 * instant at which somebody confirmed it, so "goal text alone never creates a
 * Habit" is a property of the type rather than a check a future route could
 * forget to run. `sourceRef` is the proposal or goal it came from, or null for
 * a habit the user typed themselves; it is an id, never the text.
 */
export interface HabitConfirmation {
  readonly confirmedByUserAt: string;
  readonly sourceRef: string | null;
  /**
   * True when the person accepted the cadence and duration that were suggested
   * to them unchanged. Recorded because "they took the default" and "they typed
   * it" are different evidence about how well a suggestion fit — never as an
   * input to anything this module decides.
   */
  readonly acceptedSuggestedValues: boolean;
}

export interface HabitDefinition {
  readonly schemaVersion: typeof HABIT_SCHEMA_VERSION;
  readonly habitId: string;
  readonly scopeId: string;
  readonly title: string;

  readonly cadence: HabitCadence;
  readonly durationMinutes: number;

  readonly preferredWindows: readonly HabitTimeWindow[];
  /**
   * The demand, floored and capped. `minimumOccurrences` is what the person
   * considers the habit met at in a week; `maximumOccurrences` is the ceiling
   * recovery may not push past, and it is the reason a week of skips cannot
   * pile a fortnight of gym sessions into a Sunday.
   */
  readonly minimumOccurrences: number;
  readonly maximumOccurrences: number;

  readonly flexibility: HabitFlexibility;
  readonly recoveryPolicy: HabitRecoveryPolicy;
  readonly status: HabitStatus;
  readonly source: HabitSource;
  readonly confirmation: HabitConfirmation;

  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `pending` is demand nobody has placed yet; `scheduled` is demand the adapter
 * handed to the planner and the planner found room for. `completed` and
 * `skipped` are the person's own answers. `recovered` is what a `skipped`
 * occurrence becomes once a replacement exists for it — so the row stays,
 * says what happened, and stops counting as outstanding demand.
 */
export type HabitOccurrenceState = 'pending' | 'scheduled' | 'completed' | 'skipped' | 'recovered';

/**
 * The states that still occupy one of the week's `maximumOccurrences` slots.
 *
 * A `skipped` date is not here: the whole content of recovery is that a skip
 * gives its slot back. Neither is `recovered`, which is a skip that already
 * spent its slot on the replacement.
 */
export const HABIT_LIVE_OCCURRENCE_STATES: readonly HabitOccurrenceState[] = Object.freeze([
  'pending',
  'scheduled',
  'completed',
]);

/**
 * One date's worth of a habit's demand.
 *
 * `ordinal` distinguishes two occurrences on one date, which is not a
 * hypothetical: `retry_same_day` produces exactly that. It is also half of the
 * deterministic id — `{habitId}.{localDate}.{ordinal}` — which is what makes
 * re-running materialization address the rows it already wrote instead of
 * writing a second gym session beside each of them.
 */
export interface HabitOccurrence {
  readonly occurrenceId: string;
  readonly habitId: string;
  /** `YYYY-MM-DD` in the user's own zone. Never an instant; see the header. */
  readonly localDate: string;
  readonly ordinal: number;
  readonly state: HabitOccurrenceState;
  readonly durationMinutes: number;
  /** The skipped occurrence this one replaces, or null for cadence demand. */
  readonly recoveredFromOccurrenceId: string | null;
}

/** An inclusive civil-date range. Both ends are `YYYY-MM-DD`. */
export interface HabitHorizon {
  readonly fromLocalDate: string;
  readonly toLocalDate: string;
}

/**
 * What a model or a survey may produce: a suggestion, and nothing that can be
 * stored as a habit.
 *
 * It has no `habitId`, no `status`, no `createdAt` and no `confirmation`, so
 * there is no assignment, spread or cast that turns one into a
 * `HabitDefinition` without going through `confirmHabitProposal` — which takes
 * the cadence and the duration from the *confirmation*, not from here. The
 * suggested values travel only so a screen can pre-fill the fields the person
 * is about to accept or change.
 *
 * The same shape as the Seed flow (#519), for the same reason: the arrow from
 * a proposal to a real thing is a user action, and there is no other arrow.
 */
export interface HabitProposal {
  readonly proposalId: string;
  readonly scopeId: string;
  readonly title: string;
  readonly suggestedCadence: HabitCadence;
  readonly suggestedDurationMinutes: number;
  readonly suggestedPreferredWindows: readonly HabitTimeWindow[];
  /** Which goal, memory record or onboarding answer prompted this. An id. */
  readonly sourceRef: string;
  readonly source: Exclude<HabitSource, 'user_created'>;
  readonly createdAt: string;
}

/**
 * What the person actually confirmed.
 *
 * `cadence` and `durationMinutes` are required rather than defaulted from the
 * proposal. That is the issue's "the user must explicitly confirm its cadence
 * and duration" expressed as a type: a caller that wants the suggestion has to
 * copy it across, and a caller that forgot cannot compile.
 */
export interface HabitConfirmationInput {
  readonly cadence: HabitCadence;
  readonly durationMinutes: number;
  readonly preferredWindows?: readonly HabitTimeWindow[];
  readonly minimumOccurrences?: number;
  readonly maximumOccurrences?: number;
  readonly flexibility?: HabitFlexibility;
  readonly recoveryPolicy?: HabitRecoveryPolicy;
  readonly title?: string;
}

/** What a caller may supply. Server-owned fields are not among them. */
export type HabitDefinitionInput = Omit<
  HabitDefinition,
  'schemaVersion' | 'habitId' | 'status' | 'createdAt' | 'updatedAt'
>;

/** A user edit. Every field is optional; `status` is how a habit is paused. */
export interface HabitPatchInput {
  readonly title?: string;
  readonly cadence?: HabitCadence;
  readonly durationMinutes?: number;
  readonly preferredWindows?: readonly HabitTimeWindow[];
  readonly minimumOccurrences?: number;
  readonly maximumOccurrences?: number;
  readonly flexibility?: HabitFlexibility;
  readonly recoveryPolicy?: HabitRecoveryPolicy;
  readonly status?: HabitStatus;
}

export class HabitValidationError extends Error {
  constructor(message: string) {
    super(`habit: ${message}`);
    this.name = 'HabitValidationError';
  }
}

function fail(message: string): never {
  throw new HabitValidationError(message);
}

export const HABIT_FLEXIBILITIES: readonly HabitFlexibility[] = Object.freeze([
  'flexible',
  'protected_flexible',
]);

export const HABIT_RECOVERY_POLICIES: readonly HabitRecoveryPolicy[] = Object.freeze([
  'skip',
  'retry_same_day',
  'recover_within_period',
]);

export const HABIT_STATUSES: readonly HabitStatus[] = Object.freeze(['active', 'paused', 'archived']);

export const HABIT_SOURCES: readonly HabitSource[] = Object.freeze([
  'user_created',
  'goal_confirmed',
  'onboarding_confirmed',
]);

/** `YYYY-MM-DD`. Shape only; `toCivilDays` is what rejects 2026-02-30. */
export const HABIT_LOCAL_DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;

const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const WINDOW_LABEL = /^[a-z][a-z0-9_]{0,31}$/;

function parseWindow(value: unknown, label: string): HabitTimeWindow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.start !== 'string' || !HHMM.test(raw.start)) fail(`${label}.start must be HH:MM`);
  if (typeof raw.end !== 'string' || !HHMM.test(raw.end)) fail(`${label}.end must be HH:MM`);
  // Same reasoning as the routine profile's: a zero-length window is inside
  // nothing, so it would silently mean "this preference can never be met".
  if (raw.start === raw.end) fail(`${label} starts and ends at the same minute`);
  if (raw.label !== undefined && raw.label !== null
    && (typeof raw.label !== 'string' || !WINDOW_LABEL.test(raw.label))) {
    fail(`${label}.label must match ${String(WINDOW_LABEL)}`);
  }
  return Object.freeze({
    start: raw.start,
    end: raw.end,
    ...(typeof raw.label === 'string' ? { label: raw.label } : {}),
  });
}

function parseWindows(value: unknown, label: string): readonly HabitTimeWindow[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  if (value.length > HABIT_MAX_PREFERRED_WINDOWS) {
    fail(`${label} may hold at most ${HABIT_MAX_PREFERRED_WINDOWS} windows`);
  }
  return Object.freeze(value.map((entry, index) => parseWindow(entry, `${label}[${index}]`)));
}

function parseCount(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${label} must be an integer`);
  if (value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
  return value;
}

export function parseHabitCadence(value: unknown, label = 'cadence'): HabitCadence {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'weekly_count') {
    return Object.freeze({
      kind: 'weekly_count' as const,
      count: parseCount(raw.count, `${label}.count`, 1, HABIT_MAX_OCCURRENCES_PER_PERIOD),
    });
  }
  if (raw.kind === 'weekdays') {
    if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) {
      fail(`${label}.weekdays must be a non-empty array`);
    }
    const weekdays = raw.weekdays.map((entry, index) =>
      parseCount(entry, `${label}.weekdays[${index}]`, 0, 6));
    const unique = weekdays.filter((day, index) => weekdays.indexOf(day) === index)
      .sort((left, right) => left - right);
    // A repeated weekday is not "twice on Tuesday": the cadence names days, and
    // the second Tuesday would collapse onto the first date and vanish
    // silently, leaving a habit that asks for less than the user typed.
    if (unique.length !== weekdays.length) fail(`${label}.weekdays must not repeat a day`);
    return Object.freeze({ kind: 'weekdays' as const, weekdays: Object.freeze(unique) });
  }
  fail(`${label}.kind must be weekly_count or weekdays`);
}

/** The number of dates this cadence asks for in one full week. */
export function cadenceOccurrencesPerPeriod(cadence: HabitCadence): number {
  return cadence.kind === 'weekly_count' ? cadence.count : cadence.weekdays.length;
}

function parseConfirmation(value: unknown): HabitConfirmation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    // The invariant, at the boundary. A body with no confirmation is a caller
    // trying to create a habit nobody agreed to, and the answer is no — not a
    // habit stamped with the server's clock, which would make the receipt a
    // formality instead of evidence.
    fail('confirmation is required: a habit exists only once a person confirmed it');
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.confirmedByUserAt !== 'string' || Number.isNaN(Date.parse(raw.confirmedByUserAt))) {
    fail('confirmation.confirmedByUserAt must be an ISO-8601 instant');
  }
  if (raw.sourceRef !== null && raw.sourceRef !== undefined && typeof raw.sourceRef !== 'string') {
    fail('confirmation.sourceRef must be a string or null');
  }
  if (typeof raw.acceptedSuggestedValues !== 'boolean') {
    fail('confirmation.acceptedSuggestedValues must be a boolean');
  }
  return Object.freeze({
    confirmedByUserAt: raw.confirmedByUserAt,
    sourceRef: typeof raw.sourceRef === 'string' ? raw.sourceRef : null,
    acceptedSuggestedValues: raw.acceptedSuggestedValues,
  });
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string') fail('title must be a string');
  const title = value.trim();
  if (title === '') fail('title must not be empty');
  if (title.length > HABIT_MAX_TITLE_LENGTH) {
    fail(`title must be at most ${HABIT_MAX_TITLE_LENGTH} characters`);
  }
  return title;
}

/**
 * Checks the three counts against each other.
 *
 * Separated out because the patch path has to run it too, against a mix of new
 * and existing fields — and a patch that raised `minimumOccurrences` above the
 * ceiling would leave a habit that can never be met, which is the one state
 * this domain must not be able to represent.
 */
function checkBounds(
  cadence: HabitCadence,
  minimumOccurrences: number,
  maximumOccurrences: number,
): void {
  if (minimumOccurrences > maximumOccurrences) {
    fail('minimumOccurrences must not exceed maximumOccurrences');
  }
  const perPeriod = cadenceOccurrencesPerPeriod(cadence);
  if (perPeriod > maximumOccurrences) {
    fail(`the cadence asks for ${perPeriod} a week, above maximumOccurrences ${maximumOccurrences}`);
  }
  if (perPeriod < minimumOccurrences) {
    fail(`the cadence asks for ${perPeriod} a week, below minimumOccurrences ${minimumOccurrences}`);
  }
}

export function parseHabitDefinitionInput(value: unknown): HabitDefinitionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('body must be an object');
  const raw = value as Record<string, unknown>;

  if (typeof raw.scopeId !== 'string' || raw.scopeId === '') fail('scopeId must be a non-empty string');
  const cadence = parseHabitCadence(raw.cadence);
  const durationMinutes = parseCount(raw.durationMinutes, 'durationMinutes', 1, HABIT_MAX_DURATION_MINUTES);
  const maximumOccurrences = parseCount(
    raw.maximumOccurrences ?? cadenceOccurrencesPerPeriod(cadence),
    'maximumOccurrences',
    1,
    HABIT_MAX_OCCURRENCES_PER_PERIOD,
  );
  const minimumOccurrences = parseCount(
    raw.minimumOccurrences ?? cadenceOccurrencesPerPeriod(cadence),
    'minimumOccurrences',
    0,
    HABIT_MAX_OCCURRENCES_PER_PERIOD,
  );
  checkBounds(cadence, minimumOccurrences, maximumOccurrences);

  if (!HABIT_FLEXIBILITIES.includes(raw.flexibility as HabitFlexibility)) {
    fail(`flexibility must be one of ${HABIT_FLEXIBILITIES.join(', ')}`);
  }
  if (!HABIT_RECOVERY_POLICIES.includes(raw.recoveryPolicy as HabitRecoveryPolicy)) {
    fail(`recoveryPolicy must be one of ${HABIT_RECOVERY_POLICIES.join(', ')}`);
  }
  if (!HABIT_SOURCES.includes(raw.source as HabitSource)) {
    fail(`source must be one of ${HABIT_SOURCES.join(', ')}`);
  }

  return Object.freeze({
    scopeId: raw.scopeId,
    title: parseTitle(raw.title),
    cadence,
    durationMinutes,
    preferredWindows: parseWindows(raw.preferredWindows, 'preferredWindows'),
    minimumOccurrences,
    maximumOccurrences,
    flexibility: raw.flexibility as HabitFlexibility,
    recoveryPolicy: raw.recoveryPolicy as HabitRecoveryPolicy,
    source: raw.source as HabitSource,
    confirmation: parseConfirmation(raw.confirmation),
  });
}

export function parseHabitPatchInput(value: unknown): HabitPatchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('body must be an object');
  const raw = value as Record<string, unknown>;
  // Named explicitly so a patch cannot carry `source`, `confirmation` or
  // `createdAt` past this point. Editing a habit is not re-confirming it, and a
  // patch that could rewrite the receipt would make the receipt worthless.
  const patch: Record<string, unknown> = {};
  if (raw.title !== undefined) patch.title = parseTitle(raw.title);
  if (raw.cadence !== undefined) patch.cadence = parseHabitCadence(raw.cadence);
  if (raw.durationMinutes !== undefined) {
    patch.durationMinutes = parseCount(raw.durationMinutes, 'durationMinutes', 1, HABIT_MAX_DURATION_MINUTES);
  }
  if (raw.preferredWindows !== undefined) {
    patch.preferredWindows = parseWindows(raw.preferredWindows, 'preferredWindows');
  }
  if (raw.minimumOccurrences !== undefined) {
    patch.minimumOccurrences = parseCount(raw.minimumOccurrences, 'minimumOccurrences', 0, HABIT_MAX_OCCURRENCES_PER_PERIOD);
  }
  if (raw.maximumOccurrences !== undefined) {
    patch.maximumOccurrences = parseCount(raw.maximumOccurrences, 'maximumOccurrences', 1, HABIT_MAX_OCCURRENCES_PER_PERIOD);
  }
  if (raw.flexibility !== undefined) {
    if (!HABIT_FLEXIBILITIES.includes(raw.flexibility as HabitFlexibility)) {
      fail(`flexibility must be one of ${HABIT_FLEXIBILITIES.join(', ')}`);
    }
    patch.flexibility = raw.flexibility;
  }
  if (raw.recoveryPolicy !== undefined) {
    if (!HABIT_RECOVERY_POLICIES.includes(raw.recoveryPolicy as HabitRecoveryPolicy)) {
      fail(`recoveryPolicy must be one of ${HABIT_RECOVERY_POLICIES.join(', ')}`);
    }
    patch.recoveryPolicy = raw.recoveryPolicy;
  }
  if (raw.status !== undefined) {
    if (!HABIT_STATUSES.includes(raw.status as HabitStatus)) {
      fail(`status must be one of ${HABIT_STATUSES.join(', ')}`);
    }
    patch.status = raw.status;
  }
  return Object.freeze(patch) as HabitPatchInput;
}

/** Applies a validated patch, re-checking the counts against each other. */
export function applyHabitPatch(
  existing: HabitDefinition,
  patch: HabitPatchInput,
  now: string,
): HabitDefinition {
  const cadence = patch.cadence ?? existing.cadence;
  const minimumOccurrences = patch.minimumOccurrences ?? existing.minimumOccurrences;
  const maximumOccurrences = patch.maximumOccurrences ?? existing.maximumOccurrences;
  checkBounds(cadence, minimumOccurrences, maximumOccurrences);
  return Object.freeze({
    ...existing,
    title: patch.title ?? existing.title,
    cadence,
    durationMinutes: patch.durationMinutes ?? existing.durationMinutes,
    preferredWindows: Object.freeze([...(patch.preferredWindows ?? existing.preferredWindows)]),
    minimumOccurrences,
    maximumOccurrences,
    flexibility: patch.flexibility ?? existing.flexibility,
    recoveryPolicy: patch.recoveryPolicy ?? existing.recoveryPolicy,
    status: patch.status ?? existing.status,
    updatedAt: now,
  });
}

/** Stamps the server-owned fields onto a validated input. Born `active`. */
export function buildHabitDefinition(
  habitId: string,
  input: HabitDefinitionInput,
  now: string,
): HabitDefinition {
  return Object.freeze({
    schemaVersion: HABIT_SCHEMA_VERSION,
    habitId,
    scopeId: input.scopeId,
    title: input.title,
    cadence: input.cadence,
    durationMinutes: input.durationMinutes,
    preferredWindows: Object.freeze([...input.preferredWindows]),
    minimumOccurrences: input.minimumOccurrences,
    maximumOccurrences: input.maximumOccurrences,
    flexibility: input.flexibility,
    recoveryPolicy: input.recoveryPolicy,
    status: 'active' as const,
    source: input.source,
    confirmation: input.confirmation,
    createdAt: now,
    updatedAt: now,
  });
}

/** Shape guard for a document read back, so a hand-edited one is skipped. */
export function isHabitDefinition(value: unknown): value is HabitDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== HABIT_SCHEMA_VERSION) return false;
  if (typeof raw.habitId !== 'string' || raw.habitId === '') return false;
  if (!HABIT_STATUSES.includes(raw.status as HabitStatus)) return false;
  try {
    parseHabitDefinitionInput(raw);
  } catch {
    return false;
  }
  return true;
}

export interface HabitStore {
  /** Creates the habit at a server-minted id. */
  create(input: HabitDefinitionInput, now: string): Promise<HabitDefinition>;
  /** One habit in this scope. An id from another scope reads as absent. */
  get(scopeId: string, habitId: string): Promise<HabitDefinition | null>;
  /** Every habit in the scope, including paused and archived ones. */
  list(scopeId: string): Promise<readonly HabitDefinition[]>;
  /** Applies a user patch. Null when the habit is not in the scope. */
  patch(
    scopeId: string,
    habitId: string,
    patch: HabitPatchInput,
    now: string,
  ): Promise<HabitDefinition | null>;
  /** Removes outright. Returns false when not found in this scope. */
  remove(scopeId: string, habitId: string): Promise<boolean>;
  /** Removes every habit in a scope. Returns the number deleted. */
  deleteScope(scopeId: string): Promise<number>;
}

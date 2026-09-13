/**
 * The routine survey's five answers, and the windows they stand for
 * (UC-2.R1 #171, UC-2.7a #167).
 *
 * ── Chips here, windows on the wire ──────────────────────────────
 *
 * The screen asks five multiple-choice questions. What it stores and sends is
 * the *time window* each choice means — `{ start: '22:30', end: '07:30' }` —
 * because that is what the server plans with (`UserRoutineProfile`), and what
 * UC-2.9 (#170) needs to answer "is 23:00 inside quiet hours".
 *
 * The mapping goes both ways: `windowFor` to save, `choiceFrom` to re-open a
 * saved profile on the right chip. Both are exhaustive over the enum, so
 * adding a sixth option fails the typecheck rather than silently defaulting.
 *
 * The values are the Flutter survey's, unchanged (`archive/flutter-final`,
 * `routine_survey_screen.dart`). They are somebody's already-answered
 * questions; changing them would silently re-interpret every stored profile.
 */

export type SleepChoice = 'early' | 'standard' | 'late';
export type FocusChoice = 'workday' | 'early' | 'afternoon' | 'none';
export type FixedChoice = 'none' | 'morning' | 'afternoon' | 'evening';
export type ReminderChoice = 'soft' | 'followUp' | 'strong';
export type QuietChoice = 'early' | 'standard' | 'late' | 'none';

export type ReminderIntensity = 'none' | 'softAwareness' | 'followUp' | 'strongReminder';

export interface RoutineTimeWindow {
  start: string;
  end: string;
  // `| undefined` explicitly: the app compiles with exactOptionalPropertyTypes,
  // and the Zod-inferred shape this is compared against carries it.
  label?: string | undefined;
}

/** The five answers as the screen holds them. `null` means not answered yet. */
export interface RoutineAnswers {
  sleep: SleepChoice | null;
  focus: FocusChoice | null;
  fixed: FixedChoice | null;
  reminder: ReminderChoice | null;
  quiet: QuietChoice | null;
}

export const EMPTY_ANSWERS: RoutineAnswers = {
  sleep: null, focus: null, fixed: null, reminder: null, quiet: null,
};

/** The order the questions are asked in, which is also the order they render. */
export const ROUTINE_QUESTIONS = ['sleep', 'focus', 'fixed', 'reminder', 'quiet'] as const;
export type RoutineQuestion = (typeof ROUTINE_QUESTIONS)[number];

export const ROUTINE_OPTIONS: {
  sleep: readonly SleepChoice[];
  focus: readonly FocusChoice[];
  fixed: readonly FixedChoice[];
  reminder: readonly ReminderChoice[];
  quiet: readonly QuietChoice[];
} = {
  sleep: ['early', 'standard', 'late'],
  focus: ['workday', 'early', 'afternoon', 'none'],
  fixed: ['none', 'morning', 'afternoon', 'evening'],
  reminder: ['soft', 'followUp', 'strong'],
  quiet: ['early', 'standard', 'late', 'none'],
};

const SLEEP_WINDOWS: Record<SleepChoice, RoutineTimeWindow> = {
  early: { start: '22:30', end: '06:30' },
  standard: { start: '23:30', end: '07:30' },
  late: { start: '00:30', end: '08:30' },
};

const FOCUS_WINDOWS: Record<FocusChoice, RoutineTimeWindow | null> = {
  workday: { start: '09:00', end: '17:00', label: 'work_study' },
  early: { start: '08:00', end: '16:00', label: 'work_study' },
  afternoon: { start: '12:00', end: '18:00', label: 'work_study' },
  none: null,
};

const FIXED_WINDOWS: Record<FixedChoice, RoutineTimeWindow | null> = {
  none: null,
  morning: { start: '07:00', end: '09:00', label: 'fixed_commitments' },
  afternoon: { start: '14:00', end: '16:00', label: 'fixed_commitments' },
  evening: { start: '18:00', end: '20:00', label: 'fixed_commitments' },
};

const QUIET_WINDOWS: Record<QuietChoice, RoutineTimeWindow | null> = {
  early: { start: '21:30', end: '06:30' },
  standard: { start: '22:30', end: '07:30' },
  late: { start: '23:30', end: '08:30' },
  none: null,
};

const REMINDER_INTENSITY: Record<ReminderChoice, ReminderIntensity> = {
  soft: 'softAwareness',
  followUp: 'followUp',
  strong: 'strongReminder',
};

const INTENSITY_CHOICE: Record<ReminderIntensity, ReminderChoice> = {
  none: 'soft',
  softAwareness: 'soft',
  followUp: 'followUp',
  strongReminder: 'strong',
};

function sameWindow(a: RoutineTimeWindow | null, b: RoutineTimeWindow | null | undefined): boolean {
  if (!a || !b) return false;
  return a.start === b.start && a.end === b.end;
}

function choiceByWindow<K extends string>(
  table: Record<K, RoutineTimeWindow | null>,
  window: RoutineTimeWindow | null | undefined,
): K | null {
  if (!window) return null;
  for (const key of Object.keys(table) as K[]) {
    if (sameWindow(table[key], window)) return key;
  }
  return null;
}

/** The body `PUT /api/mobile/profile/routine` takes. */
export interface RoutineProfilePayload {
  timezone: string;
  sleepWindow: RoutineTimeWindow | null;
  focusWindows: RoutineTimeWindow[];
  fixedCommitmentWindows: RoutineTimeWindow[];
  preferredReminderIntensity: ReminderIntensity;
  quietHours: RoutineTimeWindow | null;
  surveySkipped: boolean;
}

/**
 * The answers as the server takes them.
 *
 * An unanswered question sends nothing rather than a default. The server files
 * one fact per *answered* question, so a default here would become a stated
 * preference the user never expressed — and would then outrank a real answer
 * given later, because both are `user_stated`.
 *
 * `preferredReminderIntensity` is the one exception: the server's contract
 * requires it, and `softAwareness` is the gentlest setting rather than a guess
 * about the person. It is also what the Flutter survey defaulted to.
 */
export function toRoutinePayload(
  answers: RoutineAnswers,
  timezone: string,
  options: { skipped?: boolean } = {},
): RoutineProfilePayload {
  const focus = answers.focus ? FOCUS_WINDOWS[answers.focus] : null;
  const fixed = answers.fixed ? FIXED_WINDOWS[answers.fixed] : null;
  return {
    timezone,
    sleepWindow: answers.sleep ? SLEEP_WINDOWS[answers.sleep] : null,
    focusWindows: focus ? [focus] : [],
    fixedCommitmentWindows: fixed ? [fixed] : [],
    preferredReminderIntensity: answers.reminder ? REMINDER_INTENSITY[answers.reminder] : 'softAwareness',
    quietHours: answers.quiet ? QUIET_WINDOWS[answers.quiet] : null,
    surveySkipped: options.skipped === true,
  };
}

/** Re-opens a stored profile on the chips it was saved from. */
export function fromRoutinePayload(payload: Partial<RoutineProfilePayload> | null | undefined): RoutineAnswers {
  if (!payload) return { ...EMPTY_ANSWERS };
  const focus = payload.focusWindows?.[0] ?? null;
  const fixed = payload.fixedCommitmentWindows?.[0] ?? null;
  return {
    sleep: choiceByWindow(SLEEP_WINDOWS, payload.sleepWindow),
    // "No regular time" is stored as an empty list, which is indistinguishable
    // from "not answered" on the wire — so it reads as answered only when the
    // rest of the profile says the survey was completed.
    focus: focus ? choiceByWindow(FOCUS_WINDOWS, focus) : null,
    fixed: fixed ? choiceByWindow(FIXED_WINDOWS, fixed) : null,
    reminder: payload.preferredReminderIntensity
      ? INTENSITY_CHOICE[payload.preferredReminderIntensity]
      : null,
    quiet: choiceByWindow(QUIET_WINDOWS, payload.quietHours),
  };
}

/** True once every question has an answer; the survey is skippable regardless. */
export function isComplete(answers: RoutineAnswers): boolean {
  return ROUTINE_QUESTIONS.every(question => answers[question] !== null);
}

export function answeredCount(answers: RoutineAnswers): number {
  return ROUTINE_QUESTIONS.filter(question => answers[question] !== null).length;
}

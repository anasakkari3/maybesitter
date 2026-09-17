/**
 * The guided setup's questions and rules (UC-3.17, #469).
 *
 * ── What this replaces ───────────────────────────────────────────
 *
 * Onboarding used to offer one empty "About you" box, and the 2026-09 device
 * audits watched people stare at it and skip. Five concrete questions with
 * chip starters get answers where a blank box got none. The answers are only
 * ever *composed* into the same free text the describe endpoint already reads
 * — `POST /api/mobile/profile/describe` is untouched, and the review step
 * stays the only writer of memory facts.
 *
 * ── Why the caps are here and not on the screen ──────────────────
 *
 * The server rejects a description over `MAX_DESCRIPTION_LENGTH`. Five answers
 * of `MAX_ANSWER_LENGTH` plus the longest labels in any locale must fit under
 * it, so the user can never reach the last question and be told the text is
 * too long. A test composes that worst case in every locale; if a label grows
 * past what fits, that test — not a 400 on a real phone — is what fails.
 */
import { type Strings } from '../../i18n/strings';
import { MAX_DESCRIPTION_LENGTH } from './aboutYou';

export type SetupQuestionId = 'work' | 'day' | 'places' | 'done' | 'habits';

export interface SetupQuestion {
  id: SetupQuestionId;
  /** The short heading, and the prefix of the composed line. */
  labelKey: keyof Strings;
  /** The question as asked on screen. */
  promptKey: keyof Strings;
  /** Starter sentences; tapping one replaces the field with its copy. */
  chipKeys: readonly (keyof Strings)[];
}

/** In the order the screen walks them. */
export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  {
    id: 'work',
    labelKey: 'obSetupWorkLabel',
    promptKey: 'obSetupWorkPrompt',
    chipKeys: ['obSetupWorkChip1', 'obSetupWorkChip2', 'obSetupWorkChip3', 'obSetupWorkChip4', 'obSetupWorkChip5'],
  },
  {
    id: 'day',
    labelKey: 'obSetupDayLabel',
    promptKey: 'obSetupDayPrompt',
    chipKeys: ['obSetupDayChip1', 'obSetupDayChip2', 'obSetupDayChip3', 'obSetupDayChip4'],
  },
  {
    id: 'places',
    labelKey: 'obSetupPlacesLabel',
    promptKey: 'obSetupPlacesPrompt',
    chipKeys: ['obSetupPlacesChip1', 'obSetupPlacesChip2', 'obSetupPlacesChip3', 'obSetupPlacesChip4', 'obSetupPlacesChip5'],
  },
  {
    id: 'done',
    labelKey: 'obSetupDoneLabel',
    promptKey: 'obSetupDonePrompt',
    chipKeys: ['obSetupDoneChip1', 'obSetupDoneChip2', 'obSetupDoneChip3', 'obSetupDoneChip4', 'obSetupDoneChip5'],
  },
  {
    id: 'habits',
    labelKey: 'obSetupHabitsLabel',
    promptKey: 'obSetupHabitsPrompt',
    chipKeys: ['obSetupHabitsChip1', 'obSetupHabitsChip2', 'obSetupHabitsChip3', 'obSetupHabitsChip4', 'obSetupHabitsChip5'],
  },
];

/**
 * Per answer, in code points.
 *
 * 5 × 150 = 750, which leaves 250 for five labels and four newlines in the
 * widest locale — see the worst-case test in `setupChat.test.ts`.
 */
export const MAX_ANSWER_LENGTH = 150;

export type SetupAnswers = Record<SetupQuestionId, string>;

export const EMPTY_SETUP_ANSWERS: SetupAnswers = { work: '', day: '', places: '', done: '', habits: '' };

/** How many questions got a real answer — whitespace is not one. */
export function answeredCount(answers: SetupAnswers): number {
  return SETUP_QUESTIONS.filter((question) => answers[question.id].trim() !== '').length;
}

/**
 * Trimmed and cut to `MAX_ANSWER_LENGTH` code points.
 *
 * Code points rather than UTF-16 units: `slice` on the string would split an
 * emoji or a surrogate pair in two and send the server a lone half.
 */
export function clampAnswer(text: string): string {
  return Array.from(text.trim()).slice(0, MAX_ANSWER_LENGTH).join('');
}

/**
 * The text the describe endpoint reads: one `<label>: <answer>` line per
 * answered question, in question order, or `''` when nothing was answered.
 *
 * Every answer is clamped again here, so a value that reached this function
 * by a path other than the field (a restored cache, say) cannot push the
 * whole past the server cap. The final cut is belt and braces: the test
 * proves it never triggers with the current labels.
 */
export function composeDescription(answers: SetupAnswers, t: Strings): string {
  const lines: string[] = [];
  for (const question of SETUP_QUESTIONS) {
    const answer = clampAnswer(answers[question.id]);
    if (answer === '') continue;
    lines.push(`${t[question.labelKey]}: ${answer}`);
  }
  return lines.join('\n').slice(0, MAX_DESCRIPTION_LENGTH);
}

/** The index after `index`, or null on the last question (or off the end). */
export function nextQuestionIndex(index: number): number | null {
  return index >= 0 && index < SETUP_QUESTIONS.length - 1 ? index + 1 : null;
}

/** The index before `index`, or null on the first question (or off the start). */
export function previousQuestionIndex(index: number): number | null {
  return index > 0 && index < SETUP_QUESTIONS.length ? index - 1 : null;
}

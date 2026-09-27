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
 * The server rejects a description over `MAX_DESCRIPTION_LENGTH`. The first
 * question is a life narrative with its own larger cap; the four short ones
 * share whatever budget it leaves, so the composed text always fits and the
 * user is never told at the last screen that it is too long. `answerCap` is
 * what the field enforces and `composeDescription` applies the same rule, so
 * nothing the user can see is cut invisibly.
 *
 * ── The first question is a narrative, not a field ───────────────
 *
 * A chip like "I'm a student" reads as the answer, and a one-field answer is
 * a survey, not somebody being understood. The first screen asks for a broad
 * description of somebody's life and lets the model find the structure in
 * it. Its chips are prompts to talk about, never answers, and nothing in this
 * module writes a prompt into `SetupAnswers`.
 */
import { type Strings } from '../../i18n/strings';
import { MAX_DESCRIPTION_LENGTH } from './aboutYou';

export type SetupQuestionId = 'life' | 'day' | 'places' | 'done' | 'habits';

export interface SetupQuestion {
  id: SetupQuestionId;
  /**
   * `narrative` is the open life description on the first screen; `short` is
   * one of the four concrete questions after it.
   */
  kind: 'narrative' | 'short';
  /** The prefix of the composed line. */
  labelKey: keyof Strings;
  /** The heading on screen. */
  promptKey: keyof Strings;
  /**
   * On a short question: sentences that combine in the field — a tap adds one
   * after what is there, a second tap takes it out (CL2b, `ui/chipText.ts`).
   * On the narrative: inspiration prompts that never touch the field.
   */
  chipKeys: readonly (keyof Strings)[];
  /**
   * Chips that mean "no answer" and so cannot combine with the others:
   * picking one clears the rest, picking another clears it.
   */
  exclusiveChipKeys?: readonly (keyof Strings)[];
}

/** In the order the screen walks them. */
export const SETUP_QUESTIONS: readonly SetupQuestion[] = [
  {
    id: 'life',
    kind: 'narrative',
    labelKey: 'obSetupLifeLabel',
    promptKey: 'obSetupLifeTitle',
    chipKeys: ['obSetupLifePrompt1', 'obSetupLifePrompt2', 'obSetupLifePrompt3', 'obSetupLifePrompt4'],
  },
  {
    id: 'day',
    kind: 'short',
    labelKey: 'obSetupDayLabel',
    promptKey: 'obSetupDayPrompt',
    chipKeys: ['obSetupDayChip1', 'obSetupDayChip2', 'obSetupDayChip3', 'obSetupDayChip4'],
  },
  {
    id: 'places',
    kind: 'short',
    labelKey: 'obSetupPlacesLabel',
    promptKey: 'obSetupPlacesPrompt',
    chipKeys: ['obSetupPlacesChip1', 'obSetupPlacesChip2', 'obSetupPlacesChip3', 'obSetupPlacesChip4', 'obSetupPlacesChip5'],
  },
  {
    id: 'done',
    kind: 'short',
    labelKey: 'obSetupDoneLabel',
    promptKey: 'obSetupDonePrompt',
    chipKeys: ['obSetupDoneChip1', 'obSetupDoneChip2', 'obSetupDoneChip3', 'obSetupDoneChip4', 'obSetupDoneChip5'],
    // «ما بخطر ببالي شي» — nothing to combine with.
    exclusiveChipKeys: ['obSetupDoneChip5'],
  },
  {
    id: 'habits',
    kind: 'short',
    labelKey: 'obSetupHabitsLabel',
    promptKey: 'obSetupHabitsPrompt',
    chipKeys: ['obSetupHabitsChip1', 'obSetupHabitsChip2', 'obSetupHabitsChip3', 'obSetupHabitsChip4', 'obSetupHabitsChip5'],
  },
];

/** A short question's cap, in code points, while the budget allows it. */
export const MAX_ANSWER_LENGTH = 150;

/**
 * The life narrative's cap, in code points.
 *
 * Four times a short answer, and still well under the server's 1,000 with its
 * label: the narrative is never cut to make room for the questions after it.
 */
export const MAX_LIFE_ANSWER_LENGTH = 600;

/** Below this a narrative is a stray tap on the keyboard, not an answer. */
const MIN_MEANINGFUL_LENGTH = 2;

export type SetupAnswers = Record<SetupQuestionId, string>;

export const EMPTY_SETUP_ANSWERS: SetupAnswers = { life: '', day: '', places: '', done: '', habits: '' };

/** How many questions got a real answer — whitespace is not one. */
export function answeredCount(
  answers: SetupAnswers,
  questions: readonly SetupQuestion[] = SETUP_QUESTIONS,
): number {
  return questions.filter((question) => answers[question.id].trim() !== '').length;
}

/** Enough typed to be worth reading: the first screen's CTA waits for this. */
export function hasMeaningfulAnswer(text: string): boolean {
  return Array.from(text.trim()).length >= MIN_MEANINGFUL_LENGTH;
}

/**
 * Trimmed and cut to `cap` code points.
 *
 * Code points rather than UTF-16 units: `slice` on the string would split an
 * emoji or a surrogate pair in two and send the server a lone half.
 */
export function clampAnswer(text: string, cap: number = MAX_ANSWER_LENGTH): string {
  return Array.from(text.trim()).slice(0, Math.max(0, cap)).join('');
}

function codePoints(text: string): number {
  return Array.from(text).length;
}

/**
 * The question with this id, out of the list actually being asked.
 *
 * `questions` defaults to the full five so every existing caller is unchanged.
 * It is a parameter because gap filling (`setupGaps`) asks a *subset*, and one
 * of its entries is a substituted brief narrative: looking the id up in the
 * module list would find the long one and cap the field at 600 while the
 * counter on screen said 150.
 */
function questionFor(id: SetupQuestionId, questions: readonly SetupQuestion[] = SETUP_QUESTIONS): SetupQuestion {
  return questions.find((question) => question.id === id) ?? SETUP_QUESTIONS.find((question) => question.id === id)!;
}

/**
 * The answers exactly as they will be sent, each clamped in question order:
 * the narrative to its own cap, a short answer to whatever budget is left.
 */
function composedAnswers(
  answers: SetupAnswers,
  t: Strings,
  questions: readonly SetupQuestion[] = SETUP_QUESTIONS,
): { question: SetupQuestion; answer: string }[] {
  const out: { question: SetupQuestion; answer: string }[] = [];
  let used = 0;
  for (const question of questions) {
    const raw = answers[question.id].trim();
    if (raw === '') continue;
    const overhead = codePoints(String(t[question.labelKey])) + 2 + (out.length > 0 ? 1 : 0);
    const cap = question.kind === 'narrative'
      ? MAX_LIFE_ANSWER_LENGTH
      : Math.min(MAX_ANSWER_LENGTH, MAX_DESCRIPTION_LENGTH - used - overhead);
    const answer = clampAnswer(raw, cap);
    if (answer === '') continue;
    out.push({ question, answer });
    used += overhead + codePoints(answer);
  }
  return out;
}

/**
 * How many code points the field for `id` may hold right now.
 *
 * The narrative always gets `MAX_LIFE_ANSWER_LENGTH`. A short question gets
 * `MAX_ANSWER_LENGTH` until the other answers leave less than that of the
 * server's budget, and then exactly what is left — so the field, the counter
 * and the composed text all agree, and nothing is cut after the user sees it.
 */
export function answerCap(
  answers: SetupAnswers,
  id: SetupQuestionId,
  t: Strings,
  questions: readonly SetupQuestion[] = SETUP_QUESTIONS,
): number {
  const question = questionFor(id, questions);
  if (question.kind === 'narrative') return MAX_LIFE_ANSWER_LENGTH;
  const others = composedAnswers({ ...answers, [id]: '' }, t, questions);
  const used = others.reduce(
    (sum, { question: q, answer }, i) => sum + codePoints(String(t[q.labelKey])) + 2 + (i > 0 ? 1 : 0) + codePoints(answer),
    0,
  );
  const overhead = codePoints(String(t[question.labelKey])) + 2 + (others.length > 0 ? 1 : 0);
  return Math.max(0, Math.min(MAX_ANSWER_LENGTH, MAX_DESCRIPTION_LENGTH - used - overhead));
}

/**
 * The text the describe endpoint reads: one `<label>: <answer>` line per
 * answered question, in question order, or `''` when nothing was answered.
 *
 * Every answer is clamped again here, so a value that reached this function
 * by a path other than the field (a restored cache, say) cannot push the
 * whole past the server cap. The final cut is belt and braces.
 */
export function composeDescription(
  answers: SetupAnswers,
  t: Strings,
  questions: readonly SetupQuestion[] = SETUP_QUESTIONS,
): string {
  return composedAnswers(answers, t, questions)
    .map(({ question, answer }) => `${t[question.labelKey]}: ${answer}`)
    .join('\n')
    .slice(0, MAX_DESCRIPTION_LENGTH);
}

/** The index after `index`, or null on the last question (or off the end). */
export function nextQuestionIndex(
  index: number,
  questions: readonly SetupQuestion[] = SETUP_QUESTIONS,
): number | null {
  return index >= 0 && index < questions.length - 1 ? index + 1 : null;
}

/** The index before `index`, or null on the first question (or off the start). */
export function previousQuestionIndex(
  index: number,
  questions: readonly SetupQuestion[] = SETUP_QUESTIONS,
): number | null {
  return index > 0 && index < questions.length ? index - 1 : null;
}

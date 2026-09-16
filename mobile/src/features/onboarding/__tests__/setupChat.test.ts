/**
 * The guided setup's pure rules (UC-3.17, #469).
 *
 * Three things matter here: the questions come in the order the screen walks
 * them, an answer is capped in code points (not UTF-16 units, so Arabic and
 * Hebrew are cut where a person would cut them), and the composed text can
 * never exceed the server's description cap in any locale — a cap that would
 * be checked only at the last screen is a 400 the user cannot understand.
 */
import { describe, expect, it } from '@jest/globals';
import { strings, type Lang } from '../../../i18n/strings';
import { MAX_DESCRIPTION_LENGTH } from '../aboutYou';
import {
  EMPTY_SETUP_ANSWERS,
  MAX_ANSWER_LENGTH,
  SETUP_QUESTIONS,
  answeredCount,
  clampAnswer,
  composeDescription,
  nextQuestionIndex,
  previousQuestionIndex,
  type SetupAnswers,
} from '../setupChat';

const LANGS: readonly Lang[] = ['en', 'ar', 'he'];

describe('the questions', () => {
  it('come in the order the screen walks them', () => {
    expect(SETUP_QUESTIONS.map((q) => q.id)).toEqual(['work', 'day', 'places', 'done', 'habits']);
  });

  it('name real strings for their label, prompt and chips', () => {
    expect(SETUP_QUESTIONS.map((q) => q.chipKeys.length)).toEqual([5, 4, 5, 5, 5]);
    for (const question of SETUP_QUESTIONS) {
      for (const lang of LANGS) {
        expect(strings[lang][question.labelKey]).not.toBe('');
        expect(strings[lang][question.promptKey]).not.toBe('');
        for (const key of question.chipKeys) expect(strings[lang][key]).not.toBe('');
      }
    }
    expect(SETUP_QUESTIONS[0]?.labelKey).toBe('obSetupWorkLabel');
    expect(SETUP_QUESTIONS[0]?.promptKey).toBe('obSetupWorkPrompt');
    expect(SETUP_QUESTIONS[1]?.chipKeys).toEqual([
      'obSetupDayChip1', 'obSetupDayChip2', 'obSetupDayChip3', 'obSetupDayChip4',
    ]);
  });

  it('start with nothing answered', () => {
    expect(EMPTY_SETUP_ANSWERS).toEqual({ work: '', day: '', places: '', done: '', habits: '' });
    expect(answeredCount(EMPTY_SETUP_ANSWERS)).toBe(0);
  });
});

describe('answeredCount', () => {
  it('counts only answers with something in them', () => {
    // A field the user opened and closed holds whitespace, not an answer.
    expect(answeredCount({ ...EMPTY_SETUP_ANSWERS, work: 'student', day: '   ', habits: '\n' })).toBe(1);
    expect(answeredCount({ work: 'a', day: 'b', places: 'c', done: 'd', habits: 'e' })).toBe(5);
  });
});

describe('clampAnswer', () => {
  it('trims and cuts to the cap', () => {
    expect(clampAnswer('  hello  ')).toBe('hello');
    expect(clampAnswer('a'.repeat(200))).toBe('a'.repeat(MAX_ANSWER_LENGTH));
    expect(MAX_ANSWER_LENGTH).toBe(150);
  });

  it('counts code points, so Arabic and emoji are cut where a person would', () => {
    const arabic = 'بدرس بالليل '.repeat(20);
    const clamped = clampAnswer(arabic);
    expect(Array.from(clamped)).toHaveLength(MAX_ANSWER_LENGTH);
    // Astral characters are two UTF-16 units; a unit-based cut would split one.
    const emoji = '😀'.repeat(200);
    expect(Array.from(clampAnswer(emoji))).toHaveLength(MAX_ANSWER_LENGTH);
    expect(clampAnswer(emoji)).not.toContain('�');
  });

  it('leaves a short answer alone', () => {
    expect(clampAnswer('short')).toBe('short');
  });
});

describe('composeDescription', () => {
  it('gives one labelled line per answered question, in question order', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, habits: 'reading', work: 'nursing student' };
    expect(composeDescription(answers, strings.ar)).toBe(
      `${strings.ar.obSetupWorkLabel}: nursing student\n${strings.ar.obSetupHabitsLabel}: reading`,
    );
    expect(composeDescription(answers, strings.en)).toBe('Work or study: nursing student\nHabits: reading');
  });

  it('skips blank answers and trims the rest', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, day: '  late starts  ', places: '   ' };
    expect(composeDescription(answers, strings.en)).toBe('A typical day: late starts');
  });

  it("is '' when nothing was answered", () => {
    expect(composeDescription(EMPTY_SETUP_ANSWERS, strings.en)).toBe('');
    expect(composeDescription({ ...EMPTY_SETUP_ANSWERS, work: ' \n ' }, strings.he)).toBe('');
  });

  it('never exceeds the server cap, even at five full answers in every locale', () => {
    // Worst case: every answer at the cap. If this fails the labels grew and
    // MAX_ANSWER_LENGTH must shrink — the server would reject the text.
    const full = 'x'.repeat(MAX_ANSWER_LENGTH);
    const answers: SetupAnswers = { work: full, day: full, places: full, done: full, habits: full };
    for (const lang of LANGS) {
      const composed = composeDescription(answers, strings[lang]);
      expect(composed.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    }
  });

  it('clamps an answer that slipped past the field cap', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, work: 'y'.repeat(400) };
    expect(composeDescription(answers, strings.en)).toBe(`Work or study: ${'y'.repeat(MAX_ANSWER_LENGTH)}`);
  });
});

describe('stepping through the questions', () => {
  it('goes forward until the last one', () => {
    expect(nextQuestionIndex(0)).toBe(1);
    expect(nextQuestionIndex(3)).toBe(4);
    expect(nextQuestionIndex(4)).toBeNull();
    expect(nextQuestionIndex(99)).toBeNull();
  });

  it('goes back until the first one', () => {
    expect(previousQuestionIndex(4)).toBe(3);
    expect(previousQuestionIndex(1)).toBe(0);
    expect(previousQuestionIndex(0)).toBeNull();
    expect(previousQuestionIndex(-1)).toBeNull();
  });
});

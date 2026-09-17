/**
 * The guided setup's pure rules (UC-3.17, #469).
 *
 * Four things matter here: the questions come in the order the screen walks
 * them; the first one is a life narrative with a much larger cap than the
 * four short questions after it; an answer is capped in code points (not
 * UTF-16 units, so Arabic and Hebrew are cut where a person would cut them);
 * and the composed text can never exceed the server's description cap in any
 * locale — a cap that would be checked only at the last screen is a 400 the
 * user cannot understand.
 */
import { describe, expect, it } from '@jest/globals';
import { strings, type Lang } from '../../../i18n/strings';
import { MAX_DESCRIPTION_LENGTH } from '../aboutYou';
import {
  EMPTY_SETUP_ANSWERS,
  MAX_ANSWER_LENGTH,
  MAX_LIFE_ANSWER_LENGTH,
  SETUP_QUESTIONS,
  answerCap,
  answeredCount,
  clampAnswer,
  composeDescription,
  hasMeaningfulAnswer,
  nextQuestionIndex,
  previousQuestionIndex,
  type SetupAnswers,
} from '../setupChat';

const LANGS: readonly Lang[] = ['en', 'ar', 'he'];

describe('the questions', () => {
  it('come in the order the screen walks them, starting with the life narrative', () => {
    expect(SETUP_QUESTIONS.map((q) => q.id)).toEqual(['life', 'day', 'places', 'done', 'habits']);
    expect(SETUP_QUESTIONS.map((q) => q.kind)).toEqual(['narrative', 'short', 'short', 'short', 'short']);
  });

  it('name real strings for their label, prompt and chips', () => {
    expect(SETUP_QUESTIONS.map((q) => q.chipKeys.length)).toEqual([4, 4, 5, 5, 5]);
    for (const question of SETUP_QUESTIONS) {
      for (const lang of LANGS) {
        expect(strings[lang][question.labelKey]).not.toBe('');
        expect(strings[lang][question.promptKey]).not.toBe('');
        for (const key of question.chipKeys) expect(strings[lang][key]).not.toBe('');
      }
    }
    expect(SETUP_QUESTIONS[0]?.labelKey).toBe('obSetupLifeLabel');
    expect(SETUP_QUESTIONS[0]?.promptKey).toBe('obSetupLifeTitle');
    expect(SETUP_QUESTIONS[0]?.chipKeys).toEqual([
      'obSetupLifePrompt1', 'obSetupLifePrompt2', 'obSetupLifePrompt3', 'obSetupLifePrompt4',
    ]);
  });

  it('keeps the first screen to at most four inspiration prompts', () => {
    expect(SETUP_QUESTIONS[0]!.chipKeys.length).toBeLessThanOrEqual(4);
  });

  it('start with nothing answered', () => {
    expect(EMPTY_SETUP_ANSWERS).toEqual({ life: '', day: '', places: '', done: '', habits: '' });
    expect(answeredCount(EMPTY_SETUP_ANSWERS)).toBe(0);
  });
});

describe('answeredCount', () => {
  it('counts only answers with something in them', () => {
    // A field the user opened and closed holds whitespace, not an answer.
    expect(answeredCount({ ...EMPTY_SETUP_ANSWERS, life: 'student', day: '   ', habits: '\n' })).toBe(1);
    expect(answeredCount({ life: 'a', day: 'b', places: 'c', done: 'd', habits: 'e' })).toBe(5);
  });

  it('does not count an inspiration prompt as an answer, because a prompt never reaches the answers', () => {
    // The prompts are copy, not answers: nothing in this module writes one
    // into `SetupAnswers`. The only way a prompt could count is if its words
    // were typed — which is then the user's own answer.
    const prompt = strings.ar.obSetupLifePrompt1;
    expect(answeredCount(EMPTY_SETUP_ANSWERS)).toBe(0);
    expect(hasMeaningfulAnswer(EMPTY_SETUP_ANSWERS.life)).toBe(false);
    expect(answeredCount({ ...EMPTY_SETUP_ANSWERS, life: prompt })).toBe(1);
  });
});

describe('hasMeaningfulAnswer', () => {
  it('needs a few real characters, not whitespace or a stray letter', () => {
    expect(hasMeaningfulAnswer('')).toBe(false);
    expect(hasMeaningfulAnswer('   \n  ')).toBe(false);
    expect(hasMeaningfulAnswer('a')).toBe(false);
    expect(hasMeaningfulAnswer('أنا')).toBe(true);
    expect(hasMeaningfulAnswer('I work nights')).toBe(true);
  });
});

describe('clampAnswer', () => {
  it('trims and cuts to the cap it is given, the short cap by default', () => {
    expect(clampAnswer('  hello  ')).toBe('hello');
    expect(clampAnswer('a'.repeat(200))).toBe('a'.repeat(MAX_ANSWER_LENGTH));
    expect(clampAnswer('a'.repeat(900), MAX_LIFE_ANSWER_LENGTH)).toBe('a'.repeat(MAX_LIFE_ANSWER_LENGTH));
    expect(MAX_ANSWER_LENGTH).toBe(150);
    expect(MAX_LIFE_ANSWER_LENGTH).toBe(600);
  });

  it('keeps line breaks inside a long answer', () => {
    expect(clampAnswer('  first line\nsecond line  ', MAX_LIFE_ANSWER_LENGTH)).toBe('first line\nsecond line');
  });

  it('counts code points, so Arabic and emoji are cut where a person would', () => {
    const arabic = 'بدرس بالليل '.repeat(20);
    expect(Array.from(clampAnswer(arabic))).toHaveLength(MAX_ANSWER_LENGTH);
    // Astral characters are two UTF-16 units; a unit-based cut would split one.
    const emoji = '😀'.repeat(200);
    expect(Array.from(clampAnswer(emoji))).toHaveLength(MAX_ANSWER_LENGTH);
    expect(clampAnswer(emoji)).not.toContain('�');
  });
});

describe('answerCap', () => {
  it('gives the life narrative its own large cap whatever else is answered', () => {
    const full = 'x'.repeat(MAX_ANSWER_LENGTH);
    for (const lang of LANGS) {
      expect(answerCap(EMPTY_SETUP_ANSWERS, 'life', strings[lang])).toBe(MAX_LIFE_ANSWER_LENGTH);
      expect(answerCap({ life: '', day: full, places: full, done: full, habits: full }, 'life', strings[lang]))
        .toBe(MAX_LIFE_ANSWER_LENGTH);
    }
  });

  it('gives a short question its full cap while there is room', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, life: 'x'.repeat(200) };
    for (const lang of LANGS) expect(answerCap(answers, 'day', strings[lang])).toBe(MAX_ANSWER_LENGTH);
  });

  it('shrinks a later short question when a long narrative has used the budget, and never goes negative', () => {
    const long = 'x'.repeat(MAX_LIFE_ANSWER_LENGTH);
    const full = 'y'.repeat(MAX_ANSWER_LENGTH);
    for (const lang of LANGS) {
      const t = strings[lang];
      const answers: SetupAnswers = { life: long, day: full, places: full, done: '', habits: '' };
      const cap = answerCap(answers, 'done', t);
      expect(cap).toBeLessThan(MAX_ANSWER_LENGTH);
      expect(cap).toBeGreaterThanOrEqual(0);
      // Filling it to that cap still composes under the server limit.
      const filled = { ...answers, done: 'z'.repeat(cap) };
      expect(composeDescription(filled, t).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
      expect(answerCap(filled, 'habits', t)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('composeDescription', () => {
  it('gives one labelled line per answered question, in question order', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, habits: 'reading', life: 'nursing student' };
    expect(composeDescription(answers, strings.ar)).toBe(
      `${strings.ar.obSetupLifeLabel}: nursing student\n${strings.ar.obSetupHabitsLabel}: reading`,
    );
    expect(composeDescription(answers, strings.en)).toBe('About my life: nursing student\nHabits: reading');
  });

  it('keeps a long multiline narrative whole', () => {
    const story = `I study nursing.\nI work three evenings a week.\n${'I am trying to fit in the gym. '.repeat(10)}`.trim();
    expect(Array.from(story).length).toBeGreaterThan(MAX_ANSWER_LENGTH);
    const composed = composeDescription({ ...EMPTY_SETUP_ANSWERS, life: story }, strings.en);
    expect(composed).toBe(`About my life: ${story}`);
  });

  it('skips blank answers and trims the rest', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, day: '  late starts  ', places: '   ' };
    expect(composeDescription(answers, strings.en)).toBe('A typical day: late starts');
  });

  it("is '' when nothing was answered", () => {
    expect(composeDescription(EMPTY_SETUP_ANSWERS, strings.en)).toBe('');
    expect(composeDescription({ ...EMPTY_SETUP_ANSWERS, life: ' \n ' }, strings.he)).toBe('');
  });

  it('never exceeds the server cap, even with every answer at its field cap in every locale', () => {
    const answers: SetupAnswers = {
      life: 'x'.repeat(MAX_LIFE_ANSWER_LENGTH),
      day: 'x'.repeat(MAX_ANSWER_LENGTH),
      places: 'x'.repeat(MAX_ANSWER_LENGTH),
      done: 'x'.repeat(MAX_ANSWER_LENGTH),
      habits: 'x'.repeat(MAX_ANSWER_LENGTH),
    };
    for (const lang of LANGS) {
      expect(composeDescription(answers, strings[lang]).length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
    }
  });

  it('never cuts the narrative to make room for later answers', () => {
    const story = 'n'.repeat(MAX_LIFE_ANSWER_LENGTH);
    const full = 'x'.repeat(MAX_ANSWER_LENGTH);
    const answers: SetupAnswers = { life: story, day: full, places: full, done: full, habits: full };
    for (const lang of LANGS) {
      expect(composeDescription(answers, strings[lang])).toContain(`${strings[lang].obSetupLifeLabel}: ${story}`);
    }
  });

  it('clamps an answer that slipped past the field cap', () => {
    const answers: SetupAnswers = { ...EMPTY_SETUP_ANSWERS, life: 'y'.repeat(900) };
    expect(composeDescription(answers, strings.en)).toBe(`About my life: ${'y'.repeat(MAX_LIFE_ANSWER_LENGTH)}`);
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

/**
 * A clarification is one short question or it is an interview (UC-2.5, #165).
 *
 * The length is the requirement, not a preference. The question arrives on top
 * of something the person has just typed, in the one moment they expected the
 * product to be finished; a sentence they have to read twice costs more than
 * the ambiguity it resolves, and #164's edit sheet is always the better answer
 * than a long question. Eight words is the line the issue draws.
 *
 * Nothing in a diff shows this. A translator lengthening «أي وقت بناسبك؟» into
 * a polite full sentence is doing their job well by every other measure.
 *
 * The counted string is the rendered one, from `questionText`, so what is
 * measured is the sentence a user sees rather than the template — and the test
 * goes through the same mapping the screen uses rather than naming i18n keys of
 * its own.
 *
 * ── What counts as a word ────────────────────────────────────────
 *
 * A run of non-whitespace holding at least one letter or digit. `split(/\s+/)`,
 * as `noCommitmentCopy.test.ts` already settled it for #166's copy, with lone
 * punctuation («؟», «—») dropped so a language that spaces its punctuation is
 * not charged for it.
 *
 * That is the right unit for all three of these languages: Arabic and Hebrew
 * put spaces between words exactly as English does. Where they differ is that
 * both attach articles, prepositions and conjunctions to the following word
 * («بالمساء», «לסוף»), so a faithful translation of an eight-word English line
 * lands on *fewer* tokens, never more. The cap is therefore never stricter on
 * the RTL locales than on the English it was written against, which is the
 * direction the error has to go: a test must not fail a translation for the
 * grammar of its own script.
 *
 * A placeholder counts as the one word it becomes — it is rendered here, so
 * `{hour}` is counted as the "8" the user reads.
 */
import { describe, expect, it } from '@jest/globals';
import { KNOWN_OPTION_KEYS, KNOWN_QUESTION_KEYS, optionLabel, questionText } from '../../features/capture/clarificationCopy';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const LOCALES = { en, ar, he } as unknown as Record<string, Record<string, string>>;

/** Every placeholder this copy uses, so a rendered string is never starved. */
const PARAMS = { hour: '8', period: 'pm', title: 'Call the plumber', time: '16:00' };

/** The issue's limit, in words, for a question. */
const MAX_WORDS = 8;

function words(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(token => /[\p{L}\p{N}]/u.test(token));
}

describe('the clarification questions', () => {
  for (const [lang, strings] of Object.entries(LOCALES)) {
    it(`${lang}: every question is at most ${MAX_WORDS} words`, () => {
      const rendered = KNOWN_QUESTION_KEYS.map(key => ({ key, question: questionText(key, PARAMS, strings) }));
      expect(rendered.filter(({ question }) => question === null)).toEqual([]);
      // Reported as a list so a failure names the offending question and its
      // length rather than only that a number was too big.
      const tooLong = rendered
        .map(({ key, question }) => ({ key, length: words(question!).length, question }))
        .filter(({ length }) => length > MAX_WORDS);
      expect(tooLong).toEqual([]);
    });

    it(`${lang}: every option label is shorter than the question`, () => {
      // An option is a tap target, not a sentence: it has to be readable at a
      // glance in a row of three. Half the question's budget is generous.
      const rendered = KNOWN_OPTION_KEYS.map(key => ({ key, label: optionLabel(key, PARAMS, strings) }));
      expect(rendered.filter(({ label }) => label === null)).toEqual([]);
      const tooLong = rendered
        .map(({ key, label }) => ({ key, length: words(label!).length, label }))
        .filter(({ length }) => length > MAX_WORDS / 2);
      expect(tooLong).toEqual([]);
    });
  }
});

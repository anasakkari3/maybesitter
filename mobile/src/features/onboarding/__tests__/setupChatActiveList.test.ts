/**
 * What happens to `setupChat`'s helpers when the question list is shorter.
 *
 * ── The defect this file is for ──────────────────────────────────
 *
 * `answerCap`, `nextQuestionIndex` and `composeDescription` all resolved against
 * the module-level `SETUP_QUESTIONS` rather than the list they were handed. So
 * gap filling — which hands them three questions instead of five, one of them a
 * substituted brief narrative — broke two things silently:
 *
 *   - `answerCap('life')` still returned 600, because it looked the question up
 *     by id in the full list and found the narrative. The field would have
 *     accepted four times what a short question's counter shows.
 *   - `nextQuestionIndex` bounded on five, so the last question of a
 *     three-question list returned index 3 and the screen walked off the end.
 *
 * The other half of this file is the regression guard: with the full five, every
 * one of them must behave exactly as before, byte for byte.
 */
import { describe, expect, it } from '@jest/globals';
import {
  EMPTY_SETUP_ANSWERS,
  MAX_ANSWER_LENGTH,
  MAX_LIFE_ANSWER_LENGTH,
  SETUP_QUESTIONS,
  answerCap,
  composeDescription,
  nextQuestionIndex,
  previousQuestionIndex,
} from '../setupChat';
import { LIFE_BRIEF, remainingQuestions } from '../setupGaps';
import en from '../../../i18n/locales/en.json';
import type { Strings } from '../../../i18n/strings';

const t = en as unknown as Strings;

const ANSWERS = {
  ...EMPTY_SETUP_ANSWERS,
  life: 'I am a nursing student finishing a thesis',
  day: 'Lectures then a shift',
};

describe('with the full list, nothing changed', () => {
  it('gives the narrative its own long cap', () => {
    expect(answerCap(ANSWERS, 'life', t)).toBe(MAX_LIFE_ANSWER_LENGTH);
  });

  it('caps a short question at the short limit', () => {
    expect(answerCap(EMPTY_SETUP_ANSWERS, 'day', t)).toBe(MAX_ANSWER_LENGTH);
  });

  it('walks all five and stops at the end', () => {
    expect(nextQuestionIndex(0)).toBe(1);
    expect(nextQuestionIndex(SETUP_QUESTIONS.length - 1)).toBeNull();
    expect(previousQuestionIndex(0)).toBeNull();
  });

  it('composes the same text whether or not the list is passed', () => {
    expect(composeDescription(ANSWERS, t, SETUP_QUESTIONS)).toBe(composeDescription(ANSWERS, t));
  });
});

describe('with a shorter list', () => {
  const short = remainingQuestions(['schedule', 'schedule', 'household', 'household']);

  it('stops at the end of the list it was given', () => {
    expect(short.length).toBeLessThan(SETUP_QUESTIONS.length);
    expect(nextQuestionIndex(short.length - 1, short)).toBeNull();
    expect(nextQuestionIndex(0, short)).toBe(1);
  });

  it('caps the brief narrative like a short question, not like the narrative', () => {
    const brief = [LIFE_BRIEF, ...short.slice(1)];
    expect(answerCap(EMPTY_SETUP_ANSWERS, 'life', t, brief)).toBe(MAX_ANSWER_LENGTH);
  });

  it('still gives the full narrative its long cap when that is what is in the list', () => {
    expect(answerCap(EMPTY_SETUP_ANSWERS, 'life', t, SETUP_QUESTIONS)).toBe(MAX_LIFE_ANSWER_LENGTH);
  });

  it('composes only the questions it was given', () => {
    const answers = { ...EMPTY_SETUP_ANSWERS, life: 'A nursing student', day: 'Lectures then a shift' };
    // `day` was covered by the import and is not in `short`, so its answer —
    // which cannot have been typed on this run — must not reach the server.
    const composed = composeDescription(answers, t, short);
    expect(composed).toContain('A nursing student');
    expect(composed).not.toContain('Lectures then a shift');
  });
});

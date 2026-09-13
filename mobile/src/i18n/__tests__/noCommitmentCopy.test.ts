/**
 * What the app is allowed to say when it created nothing (UC-2.6, #166).
 *
 * The constraints are the point, not decoration. A message that asked for
 * nothing is very often somebody telling the product how their day went, and the
 * temptation is to respond to *that*. #166 forbids it: no advice, no emotional or
 * medical reading, no echo of what they wrote. One short neutral line saying
 * nothing was saved.
 *
 * These are asserted rather than reviewed because the failure is invisible in a
 * diff — "That sounds exhausting, nothing was saved" reads like good copy and is
 * the product deciding how somebody feels.
 */
import { describe, expect, it } from '@jest/globals';
import en from '../locales/en.json';
import ar from '../locales/ar.json';
import he from '../locales/he.json';

const REASON_KEYS = [
  'noCommitmentInformational',
  'noCommitmentGreetingOrChat',
  'noCommitmentQuestion',
  'noCommitmentPastEvent',
  'noCommitmentNegatedRequest',
  'noCommitmentLowConfidence',
] as const;

const LOCALES = { en, ar, he } as unknown as Record<string, Record<string, string>>;

/**
 * Words that would mean the product had formed a view about the person rather
 * than about their message. English only: these are the ones a reviewer writing
 * the base copy would reach for, and the other two are translated from it.
 */
const INTERPRETATION = [
  'sounds', 'seem', 'feel', 'feeling', 'tired', 'exhaust', 'stress', 'anxious', 'overwhelm',
  'sorry', 'hope', 'better', 'rest', 'relax', 'take care', 'breathe', 'deserve',
  'should', 'you might want', 'why not', 'tip:',
];

describe('the no-commitment copy', () => {
  it('exists in all three languages', () => {
    for (const [lang, strings] of Object.entries(LOCALES)) {
      for (const key of REASON_KEYS) {
        expect(typeof strings[key]).toBe('string');
        expect((strings[key] ?? '').trim().length).toBeGreaterThan(0);
      }
      expect(lang).toBeTruthy();
    }
  });

  it('stays at or under twelve words', () => {
    for (const [lang, strings] of Object.entries(LOCALES)) {
      for (const key of REASON_KEYS) {
        const words = (strings[key] ?? '').trim().split(/\s+/).length;
        expect(words).toBeLessThanOrEqual(12);
      }
      expect(lang).toBeTruthy();
    }
  });

  it('offers no advice and reads nothing into how the person feels', () => {
    for (const key of REASON_KEYS) {
      const line = (en[key as keyof typeof en] as string).toLowerCase();
      for (const word of INTERPRETATION) {
        expect(line).not.toContain(word);
      }
    }
  });

  it('never asks a question back', () => {
    // A no-commitment outcome is an answer, not the start of a conversation.
    // Clarification is #165's job and only ever for a real commitment.
    for (const [lang, strings] of Object.entries(LOCALES)) {
      for (const key of REASON_KEYS) {
        expect(strings[key]).not.toMatch(/[?؟]/);
      }
      expect(lang).toBeTruthy();
    }
  });

  it('says plainly that nothing was saved', () => {
    // Every line has to leave the user certain their day was not changed. The
    // negated-request line is the exception in wording only: "No reminder was
    // created" says the same thing about the thing they asked not to have.
    const mustReassure = REASON_KEYS.filter(key => key !== 'noCommitmentQuestion');
    for (const key of mustReassure) {
      const line = (en[key as keyof typeof en] as string).toLowerCase();
      expect(line).toMatch(/nothing|no reminder|couldn't read/);
    }
  });
});

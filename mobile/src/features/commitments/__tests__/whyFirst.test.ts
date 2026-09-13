/**
 * The top card's one line (UC-2.8 #169).
 *
 * Every code must resolve to real words in all three languages. A missing key
 * in Hebrew would show as nothing at all here — the line would silently vanish
 * for one language and nobody would see it in an English test run.
 */
import { describe, expect, it } from '@jest/globals';
import { whyFirstLine } from '../whyFirst';
import type { RankReasonCode } from '../../../api/schemas/common';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

// Through `unknown`: the locale files also carry `_meta` and a `days` array,
// and this reads only the string keys.
const strings = (locale: object) => locale as unknown as Record<string, string>;
const LOCALES: Record<string, Record<string, string>> = {
  en: strings(en), ar: strings(ar), he: strings(he),
};

/** Every code the server can send. Kept literal so a new code fails here. */
const SPEAKING_CODES: RankReasonCode[] = [
  'overdue', 'due_within_2h', 'due_today', 'user_must', 'estimated_important', 'no_deadline',
];

describe('every reason has words, in every language', () => {
  for (const [lang, strings] of Object.entries(LOCALES)) {
    for (const code of SPEAKING_CODES) {
      it(`${lang}: ${code}`, () => {
        const line = whyFirstLine([code], strings);
        expect(line).not.toBeNull();
        expect(line!.trim()).not.toBe('');
        // Not the key leaking through as its own text.
        expect(line).not.toMatch(/^todayWhy/);
      });
    }
  }
});

describe('what it declines to say', () => {
  it('says nothing for "you marked this nice"', () => {
    // Not a reason it is first. It is a reason it is not.
    expect(whyFirstLine(['user_low'], LOCALES.en!)).toBeNull();
  });

  it('says nothing when there are no reasons', () => {
    expect(whyFirstLine([], LOCALES.en!)).toBeNull();
  });

  it('ignores a code it does not know, rather than printing it', () => {
    // A server ahead of the app must not put a raw enum on a user's screen.
    expect(whyFirstLine(['invented_by_a_later_server'], LOCALES.en!)).toBeNull();
    expect(whyFirstLine(['invented_by_a_later_server', 'overdue'], LOCALES.en!))
      .toBe(en.todayWhyOverdue);
  });

  it('drops a reason whose phrase is missing rather than rendering a gap', () => {
    expect(whyFirstLine(['overdue', 'user_must'], { todayWhyOverdue: 'Past due' }))
      .toBe('Past due');
  });
});

describe('two reasons', () => {
  it('joins them in the order the server sent, deadline first', () => {
    expect(whyFirstLine(['overdue', 'user_must'], LOCALES.en!))
      .toBe(`${en.todayWhyOverdue} · ${en.todayWhyMust}`);
  });

  it('joins in Arabic and Hebrew too, with no Latin key showing through', () => {
    for (const lang of ['ar', 'he'] as const) {
      const line = whyFirstLine(['due_within_2h', 'user_must'], LOCALES[lang]!)!;
      expect(line).toContain(LOCALES[lang]!.todayWhySoon!);
      expect(line).toContain(LOCALES[lang]!.todayWhyMust!);
      expect(line).not.toMatch(/\{first\}|\{second\}/);
    }
  });

  it('never gives three, even if three arrive', () => {
    // The server caps at two; the client does not trust it to.
    const line = whyFirstLine(['overdue', 'user_must', 'no_deadline'], LOCALES.en!)!;
    expect(line).not.toContain(en.todayWhyNoDeadline);
  });
});

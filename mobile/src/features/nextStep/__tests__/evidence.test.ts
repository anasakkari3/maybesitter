/**
 * The "why" line, in the user's own language (UC-2.R3 #173).
 *
 * The test that matters is the coverage one: every code the server can emit
 * must have words in all three languages. A code with no Arabic phrase renders
 * as nothing, and the reason quietly disappears for one language only — which
 * no English-language test run would ever show.
 */
import { describe, expect, it } from '@jest/globals';
import { evidencePhrase, evidencePhrases, KNOWN_EVIDENCE_CODES } from '../evidence';
import { NEXT_STEP_EVIDENCE_CODES } from '../../../../../lib/services/nextStepEvidence';
import en from '../../../i18n/locales/en.json';
import ar from '../../../i18n/locales/ar.json';
import he from '../../../i18n/locales/he.json';

const asStrings = (locale: object) => locale as unknown as Record<string, string>;
const LOCALES = { en: asStrings(en), ar: asStrings(ar), he: asStrings(he) };

describe('the app can say every reason the server can give', () => {
  it('knows exactly the codes the server emits — no more, no fewer', () => {
    // Imported from the server module rather than retyped: a code added there
    // and forgotten here would otherwise ship as a silently missing reason.
    expect([...KNOWN_EVIDENCE_CODES].sort()).toEqual([...NEXT_STEP_EVIDENCE_CODES].sort());
  });

  for (const [lang, strings] of Object.entries(LOCALES)) {
    // Every code with no parameters. The two parametric ones are covered
    // below, and the whole set is pinned against the server's list above.
    for (const code of ['overdue', 'due_within_24h', 'due_within_7d', 'outside_usual_hours',
      'short_for_end_of_day', 'fits_before_due', 'usually_finishes', 'often_set_aside',
      'usual_productive_time', 'fits_focus_time']) {
      it(`${lang}: ${code} has words`, () => {
        const phrase = evidencePhrase({ code }, strings);
        expect(phrase).not.toBeNull();
        expect(phrase!.trim()).not.toBe('');
        expect(phrase).not.toMatch(/^evidence/);
      });
    }

    it(`${lang}: importance names the level in the same words the groups use`, () => {
      const phrase = evidencePhrase({ code: 'importance', params: { level: 'high' } }, strings)!;
      expect(phrase).toContain(strings.todayGroupMust!);
      expect(phrase).not.toContain('{level}');
    });

    it(`${lang}: an estimated importance does not claim the user said it`, () => {
      // "you marked it Must" about a guess is the product taking credit for a
      // decision the user never made, so the two codes have different words.
      const stated = evidencePhrase({ code: 'importance', params: { level: 'high' } }, strings)!;
      const guessed = evidencePhrase({ code: 'importance_estimated', params: { level: 'high' } }, strings)!;
      expect(guessed).toContain(strings.todayGroupMust!);
      expect(guessed).not.toContain('{level}');
      expect(guessed).not.toBe(stated);
    });

    it(`${lang}: effort names the number`, () => {
      const phrase = evidencePhrase({ code: 'effort', params: { minutes: 45 } }, strings)!;
      expect(phrase).toContain('45');
      expect(phrase).not.toContain('{minutes}');
    });
  }
});

describe('a server ahead of the app', () => {
  it('renders nothing for a code this build does not know', () => {
    // Never the code itself. `usual_productive_time` on someone's screen is
    // worse than one fewer reason.
    expect(evidencePhrase({ code: 'invented_next_sprint' }, LOCALES.en)).toBeNull();
  });

  it('keeps the reasons it does know, in order', () => {
    expect(evidencePhrases(
      [{ code: 'invented_next_sprint' }, { code: 'overdue' }, { code: 'fits_before_due' }],
      LOCALES.en,
    )).toEqual([en.evidenceOverdue, en.evidenceFitsBeforeDue]);
  });

  it('drops a parametric code whose parameter is missing rather than printing a gap', () => {
    expect(evidencePhrase({ code: 'importance' }, LOCALES.en)).toBeNull();
    expect(evidencePhrase({ code: 'effort' }, LOCALES.en)).toBeNull();
    expect(evidencePhrase({ code: 'effort', params: { minutes: Number.NaN } }, LOCALES.en)).toBeNull();
  });

  it('renders nothing when the build has the code but not the copy', () => {
    expect(evidencePhrase({ code: 'overdue' }, {})).toBeNull();
  });
});

describe('what is never shown', () => {
  it('does not fall back to the English label sitting next to the code', () => {
    // `evidenceLabels` travels in the same response and is English prose. It
    // must not leak onto an Arabic screen as a "better than nothing" fallback.
    expect(evidencePhrase({ code: 'unknown' }, LOCALES.ar)).toBeNull();
    for (const phrase of evidencePhrases([{ code: 'overdue' }], LOCALES.ar)) {
      expect(phrase).not.toBe('overdue');
    }
  });
});

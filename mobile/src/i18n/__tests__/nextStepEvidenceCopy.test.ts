/**
 * What the "why" line is allowed to be (UC-2.9 #170, UC-2.R3 #173).
 *
 * #170 asks for two things of every reason line, and until now neither was
 * asserted anywhere: at most ten words, and no medical or therapeutic
 * vocabulary. `features/nextStep/__tests__/evidence.test.ts` covers the other
 * half of the contract — that every code the server emits has words in all
 * three languages — but it only ever asks whether a phrase is non-empty.
 *
 * ── Why length is a rule and not taste ───────────────────────────
 *
 * The line sits under a suggestion the user did not ask for. It is the product
 * justifying itself, and a justification that runs on reads as persuasion; the
 * user is meant to be able to disagree with it in the time it takes to glance
 * at it. Ten words is the issue's line.
 *
 * ── Why the lexicon, on copy nobody would call medical ───────────
 *
 * The vocabulary is the one from `src/profile/sensitiveLexicon.ts`, reused
 * rather than restated — the same list #168 uses to throw away a suggestion
 * about somebody's health, religion, politics or money. A reason line is the
 * product explaining its own reasoning, and the moment it borrows that register
 * ("this is the kind of task you tend to avoid", "a good time to treat this")
 * it has started describing the person instead of the commitment. The lexicon
 * over-matches on purpose, which is exactly what is wanted for copy: a phrase
 * that has to argue its way past the filter is a phrase to rewrite.
 *
 * Importing the lexicon across the tree boundary follows
 * `features/nextStep/__tests__/evidence.test.ts`, which already reaches into
 * `lib/` for the server's list of codes. The alternative — a second copy of the
 * term list living in the app — is the thing the issue explicitly asked not to
 * happen.
 *
 * ── What counts as a word ────────────────────────────────────────
 *
 * A run of non-whitespace holding at least one letter or digit, as in
 * `noCommitmentCopy.test.ts` and `clarificationCopy.test.ts`. Arabic and Hebrew
 * space their words as English does, and both attach articles and prepositions
 * to the following word, so a faithful translation lands on fewer tokens than
 * its English source, never more: the cap can never fail a translation for the
 * grammar of its own script.
 */
import { describe, expect, it } from '@jest/globals';
import { evidencePhrase, KNOWN_EVIDENCE_CODES, type EvidenceItem } from '../../features/nextStep/evidence';
import { sensitiveTermIn } from '../../../../src/profile/sensitiveLexicon';
import ar from '../locales/ar.json';
import en from '../locales/en.json';
import he from '../locales/he.json';

const LOCALES = { en, ar, he } as unknown as Record<string, Record<string, string>>;

/** The issue's limit, in words, for one reason line. */
const MAX_WORDS = 10;

function words(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .filter(token => /[\p{L}\p{N}]/u.test(token));
}

/**
 * Every line the app can render, with the parametric codes rendered at each
 * value they take.
 *
 * The rendered string rather than the template, because the substitution pulls
 * in more copy — `evidenceImportance` reads "you marked it {level}" and the
 * level is `todayGroupMust`, which is where a word long enough or loaded enough
 * to break the rule could arrive without the reason line itself changing.
 */
function renderedLines(strings: Record<string, string>): { code: string; line: string }[] {
  const items: EvidenceItem[] = KNOWN_EVIDENCE_CODES.flatMap(code => {
    if (code === 'importance' || code === 'importance_estimated') {
      return ([ 'low', 'normal', 'high' ] as const).map(level => ({ code, params: { level } }));
    }
    if (code === 'effort') return [{ code, params: { minutes: 45 } }];
    return [{ code }];
  });

  return items.map(item => {
    const line = evidencePhrase(item, strings);
    expect(line).not.toBeNull();
    return { code: item.code, line: line! };
  });
}

/**
 * The same lines with the importance labels standing in for themselves.
 *
 * `evidenceImportance` renders "you marked it {level}", and the level is the
 * Must / Should / Nice label — copy this issue does not own, shown on the item
 * itself long before any reason line quotes it. It has to be out of scope here
 * for a real reason: Hebrew's «חובה» (Must) contains «חוב» (debt), and the
 * lexicon matches RTL terms as substrings on purpose, so the blunt rule that is
 * right for discarding a suggestion about somebody's finances reads the word
 * "obligation" as one. Renaming the product's importance level to get past a
 * filter aimed at something else would be the wrong end to fix.
 *
 * So the template is still checked, and so is the substitution — only the
 * substituted label's own vocabulary is not.
 */
const NEUTRAL_LEVEL = 'level';
function linesWithNeutralLevels(strings: Record<string, string>): { code: string; line: string }[] {
  return renderedLines({
    ...strings,
    todayGroupMust: NEUTRAL_LEVEL,
    todayGroupShould: NEUTRAL_LEVEL,
    todayGroupNice: NEUTRAL_LEVEL,
  });
}

/** The raw copy too, so a key that no code routes to is still held to the rule. */
function templates(strings: Record<string, string>): { code: string; line: string }[] {
  return Object.entries(strings)
    .filter(([key]) => key.startsWith('evidence'))
    .map(([key, line]) => ({ code: key, line }));
}

describe('the next-step reason lines', () => {
  for (const [lang, strings] of Object.entries(LOCALES)) {
    it(`${lang}: every reason is at most ${MAX_WORDS} words`, () => {
      const tooLong = [...renderedLines(strings), ...templates(strings)]
        .map(({ code, line }) => ({ code, length: words(line).length, line }))
        .filter(({ length }) => length > MAX_WORDS);
      expect(tooLong).toEqual([]);
    });

    it(`${lang}: no reason speaks in medical, clinical or otherwise sensitive terms`, () => {
      const loaded = [...linesWithNeutralLevels(strings), ...templates(strings)]
        .map(({ code, line }) => ({ code, term: sensitiveTermIn(line), line }))
        .filter(({ term }) => term !== null);
      expect(loaded).toEqual([]);
    });
  }
});

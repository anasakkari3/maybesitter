/**
 * The rubric: its vocabulary, its lexicons, and the one structural claim
 * (Sprint 09, issue #37).
 *
 * ── The test that matters most ──────────────────────────────────────
 *
 * `a passing tone score cannot compensate for a faithfulness failure` is the
 * acceptance criterion and it is asserted three ways, because a single
 * assertion about a union is easy to satisfy and easy to lose:
 *
 *   1. The `faithfulness_violated` variant has no `tone` key at runtime, so
 *      there is no field for an aggregator to reach.
 *   2. `toneScoresOf` returns null for it, so the one accessor agrees.
 *   3. Two rows differing **only** in prose — one with clean wording, one that
 *      would score `fail` on all three tone dimensions — produce byte-identical
 *      faithfulness results. That is the property stated as a measurement rather
 *      than as an inspection, and it is the one that would still fail if
 *      somebody later added a nullable `tone` field back.
 *
 * The lexicon tests are all in both directions. A word list is checked to fire
 * on the phrase it names *and* not to fire on a word that merely contains it,
 * because a substring matcher passes every "does it catch X" test ever written
 * while reporting a violation on ordinary prose in two of the three locales.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative as relativePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COACHING_DEFECT_CODES,
  COACHING_FORBIDDEN_LANGUAGE,
  COACHING_LOCALES,
  type CoachingDefectCode,
  type CoachingLocale,
} from '../../src/contracts/v1/coachingContracts.ts';
import {
  ACTION_BEARING_CLAIM_KINDS,
  CLAIM_KIND_FOR_NON_SUPPORT_SOURCE,
  CODE_DISPOSITIONS,
  COACHING_RUBRIC,
  COACHING_RUBRIC_VERSION,
  FAITHFULNESS_DIMENSIONS,
  PERSISTENCE_LEXICON,
  RUBRIC_DIMENSIONS,
  RUBRIC_DIMENSION_PARTITIONS,
  TONE_BANDS,
  TONE_DIMENSIONS,
  TONE_LEXICON,
  checkCoachingLanguage,
  codesForDimension,
  evaluateRubric,
  matchedPhrases,
  matchesPhrase,
  toneScoresOf,
  type RubricDimension,
  type ToneDimension,
} from '../../lib/coaching/evaluation/rubric.ts';
import { buildRow } from '../../lib/coaching/evaluation/evaluationSet.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');
const moduleDir = join(repoRoot, 'lib', 'coaching');

function sourceFilesUnder(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFilesUnder(path));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(path);
  }
  return found.sort();
}

function relative(file: string): string {
  return relativePath(repoRoot, file);
}

/**
 * Comments out, code in.
 *
 * Lifted verbatim from `tests/recommendation/recommendationBoundaries.test.ts`
 * rather than rewritten, and proved in both directions below. The silent
 * direction — a real violation hidden inside a commented-out line — is the one
 * that matters.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function sorted(values: readonly string[]): string[] {
  return values.slice().sort();
}

/* ── Never vacuous ───────────────────────────────────────────────── */

test('the coaching evaluation module exists and all three of its surfaces are scanned', () => {
  // A guard over an empty file list passes by finding nothing.
  const files = sourceFilesUnder(moduleDir).map(relative);
  assert.ok(files.length > 0, `no sources under ${relative(moduleDir)}`);
  for (const expected of [
    'lib/coaching/evaluation/rubric.ts',
    'lib/coaching/evaluation/evaluationSet.ts',
    'lib/coaching/evaluation/scoring.ts',
  ]) {
    assert.ok(files.includes(expected), `expected ${expected}; found ${files.join(', ')}`);
  }
});

/* ── Vocabulary ──────────────────────────────────────────────────── */

test('the rubric dimensions are exactly the two partitions, and the partitions are disjoint', () => {
  assert.deepEqual(
    sorted(RUBRIC_DIMENSIONS),
    sorted([...RUBRIC_DIMENSION_PARTITIONS.tone, ...RUBRIC_DIMENSION_PARTITIONS.faithfulness]),
  );
  for (const dimension of RUBRIC_DIMENSION_PARTITIONS.tone) {
    assert.equal(
      (RUBRIC_DIMENSION_PARTITIONS.faithfulness as readonly string[]).includes(dimension),
      false,
      `${dimension} is in both gates; a dimension in both is one a tone score could answer for a faithfulness failure`,
    );
  }
  assert.equal(new Set(RUBRIC_DIMENSIONS).size, RUBRIC_DIMENSIONS.length, 'a dimension is listed twice');
});

test('COACHING_RUBRIC is total over the dimensions and each spec names its own dimension', () => {
  assert.deepEqual(sorted(Object.keys(COACHING_RUBRIC)), sorted(RUBRIC_DIMENSIONS));
  for (const dimension of RUBRIC_DIMENSIONS) {
    const spec = COACHING_RUBRIC[dimension];
    assert.equal(spec.dimension, dimension);
    assert.ok(spec.humanQuestion.length > 0, `${dimension} asks a reviewer nothing`);
    assert.ok(spec.automatedSignal.length > 0, `${dimension} states no automated signal`);
    const expectedGate = (TONE_DIMENSIONS as readonly string[]).includes(dimension) ? 'tone' : 'faithfulness';
    assert.equal(spec.gate, expectedGate);
  }
});

test('every tone dimension declares itself a proxy and no faithfulness dimension does', () => {
  // The honest flag. A tone gate that claimed to measure helpfulness rather than
  // to match a word list would make the human slot look optional.
  for (const dimension of TONE_DIMENSIONS) {
    assert.equal(COACHING_RUBRIC[dimension].automatedIsProxy, true, `${dimension} must declare itself a proxy`);
  }
  for (const dimension of FAITHFULNESS_DIMENSIONS) {
    assert.equal(
      COACHING_RUBRIC[dimension].automatedIsProxy,
      false,
      `${dimension} is decided against the recommendation's own evidence; calling it a proxy understates it`,
    );
  }
});

test('CODE_DISPOSITIONS is total over every one of #38 codes, with no extras', () => {
  // Totality is what makes a code added to #38 a compile error here rather than
  // a defect this rubric silently drops.
  assert.deepEqual(sorted(Object.keys(CODE_DISPOSITIONS)), sorted(COACHING_DEFECT_CODES));
});

test('the two dimensions with no #38 code are named, not discovered', () => {
  // `helpfulness` and `calmness` are lexicon-and-structure only: #38 has no code
  // for either, and asserting "every dimension is reachable from a code" would
  // fail for the wrong reason. Naming them here means a future code that *does*
  // land on one fails this test instead of passing unnoticed.
  const withCodes = RUBRIC_DIMENSIONS.filter((dimension) => codesForDimension(dimension).length > 0);
  assert.deepEqual(
    sorted(withCodes),
    sorted(['non_shaming', 'persistence_claim', 'claim_support', 'claim_derivability', 'decision_echo_integrity']),
  );
  for (const dimension of ['helpfulness', 'calmness'] as const) {
    assert.deepEqual(codesForDimension(dimension), []);
  }
});

test('the two orthogonal partitions disagree in exactly the two places the header names', () => {
  // #38 partitions by which pass decides a code; this rubric by what a reader is
  // harmed by. A third disagreement appearing silently is how a taxonomy stops
  // meaning what its comment says.
  const faithfulnessOwned: CoachingDefectCode[] = [];
  for (const code of COACHING_DEFECT_CODES) {
    const disposition = CODE_DISPOSITIONS[code];
    if (disposition.kind === 'dimension' && (FAITHFULNESS_DIMENSIONS as readonly string[]).includes(disposition.dimension)) {
      faithfulnessOwned.push(code);
    }
  }
  const notInSprint09FaithfulnessPartition = faithfulnessOwned.filter(
    (code) => code === 'UNSOURCED_COACHING_CLAIM' || code === 'COMPLETION_DESCRIBED_AS_TRACKING',
  );
  assert.deepEqual(sorted(notInSprint09FaithfulnessPartition), sorted(['COMPLETION_DESCRIBED_AS_TRACKING', 'UNSOURCED_COACHING_CLAIM']));
  assert.equal(CODE_DISPOSITIONS.IDENTIFIER_IN_PROSE.kind, 'out_of_scope');
});

test('the non-support claim source table is total over the three kinds #38 does not table', () => {
  assert.deepEqual(sorted(Object.keys(CLAIM_KIND_FOR_NON_SUPPORT_SOURCE)), [
    'only_candidate_attestation',
    'option_confidence',
    'withholding_reason',
  ]);
});

/* ── Lexicons ────────────────────────────────────────────────────── */

test("the English lists are #38's arrays by identity, not copies of them", () => {
  // Identity, not deepEqual. Sprint 06's lesson is that two independent copies
  // of *data* are a gap waiting for whichever caller falls into it — three
  // copies of one connective lexicon disagreed on 20 of 31 probed titles. A
  // deepEqual assertion passes on a copy that has not drifted *yet*.
  assert.equal(TONE_LEXICON.en.non_shaming.disqualifying, COACHING_FORBIDDEN_LANGUAGE.shame);
  assert.equal(PERSISTENCE_LEXICON.en, COACHING_FORBIDDEN_LANGUAGE.trackingVerbs);
});

test('every lexicon list is non-empty for every locale, so no band is unreachable in any language', () => {
  for (const locale of COACHING_LOCALES) {
    for (const dimension of TONE_DIMENSIONS) {
      const entry = TONE_LEXICON[locale][dimension];
      assert.ok(entry.disqualifying.length > 0, `${locale}/${dimension} can never reach the fail band`);
      assert.ok(entry.cautionary.length > 0, `${locale}/${dimension} can never reach the borderline band`);
    }
    assert.ok(PERSISTENCE_LEXICON[locale].length > 0, `${locale} has no persistence lexicon`);
  }
});

test('the surveillance half of trackingVerbs fires in English', () => {
  // #38's reasoning is that "I'll keep an eye on that" is a false claim of
  // persistence in friendlier words and is the phrasing a template author
  // reaches for. Each of the six members #38 adds over the shipped engine's list
  // is probed individually; a spot check of one would pass while five sat dead.
  for (const phrase of ['logging', 'noting', 'monitoring', 'watching', 'keeping track', 'following up on']) {
    assert.ok(
      (COACHING_FORBIDDEN_LANGUAGE.trackingVerbs as readonly string[]).includes(phrase),
      `${phrase} is missing from #38's trackingVerbs`,
    );
    assert.deepEqual(matchedPhrases(`I am ${phrase} that for you.`, PERSISTENCE_LEXICON.en), [phrase]);
  }
});

test('the persistence lexicons fire in Arabic and Hebrew, which an English list cannot', () => {
  assert.ok(matchesPhrase('أراقب هذا البند نيابة عنك.', 'أراقب'));
  assert.ok(matchesPhrase('أتابع هذا البند.', 'أتابع'));
  assert.ok(matchesPhrase('אעקוב אחרי הפריט הזה בשבילך.', 'אעקוב'));
  assert.ok(matchesPhrase('אשים עין על הפריט הזה.', 'אשים עין'));
  // And the English list is silent on all of them, which is the whole reason
  // the other two lists exist.
  assert.deepEqual(matchedPhrases('أراقب هذا البند نيابة عنك.', PERSISTENCE_LEXICON.en), []);
  assert.deepEqual(matchedPhrases('אעקוב אחרי הפריט הזה בשבילך.', PERSISTENCE_LEXICON.en), []);
});

test('the shame lexicons fire in Arabic and Hebrew', () => {
  assert.ok(matchesPhrase('لقد فشلت في إنجاز هذا البند.', 'فشلت'));
  assert.ok(matchesPhrase('נכשלת בטיפול בפריט הזה.', 'נכשלת'));
  assert.deepEqual(matchedPhrases('لقد فشلت في إنجاز هذا البند.', TONE_LEXICON.en.non_shaming.disqualifying), []);
});

test('phrase matching is word-anchored, not a substring scan', () => {
  // The silent direction. A substring matcher passes every "does it catch X"
  // test ever written while firing on ordinary prose.
  assert.equal(matchesPhrase('The remainder is fine.', 'remind'), false);
  assert.equal(matchesPhrase('She is a classical scholar.', 'lazy'), false);
  assert.equal(matchesPhrase('This is a shameless plug.', 'shame'), false);
  assert.equal(matchesPhrase('Remind me later.', 'remind'), true);
  // Multi-word phrases still match across punctuation folding.
  assert.equal(matchesPhrase('I am keeping   track, of that.', 'keeping track'), true);
  // Arabic and Hebrew: the exact form matches, a longer word containing it
  // does not.
  assert.equal(matchesPhrase('كالعادة تماما', 'كالعادة'), true);
  assert.equal(matchesPhrase('הזמן אוזל כאן', 'הזמן אוזל'), true);
  assert.equal(matchesPhrase('כרגע', 'כרגיל'), false);
});

test('phrase matching is total: no input shape raises', () => {
  assert.equal(matchesPhrase(null, 'lazy'), false);
  assert.equal(matchesPhrase(42, 'lazy'), false);
  assert.equal(matchesPhrase(undefined, 'lazy'), false);
  assert.equal(matchesPhrase('anything', ''), false);
  assert.equal(matchesPhrase('anything', '   '), false);
  assert.deepEqual(matchedPhrases(null, ['lazy']), []);
});

test('matched phrases come back in code-point order, never locale order', () => {
  const hits = matchedPhrases('failed, lazy, avoidant', COACHING_FORBIDDEN_LANGUAGE.shame);
  assert.deepEqual(hits, hits.slice().sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
});

test('the scaffold half of #38 lexicon is a named exclusion, not a silent one', () => {
  // `disposition` is a `scaffold` member. This rubric owns no gate for internal
  // scaffolding, so it must not fire — and the day someone adds the check, this
  // test fails and the decision gets made again on purpose.
  const row = buildRow('probe/scaffold', 'sole_survivor_reason', 'en', 'clean_control', 'authored');
  const output = {
    ...row.input.output,
    sentences: [{ ...row.input.output.sentences[0], text: 'The disposition here is raw output.' }, row.input.output.sentences[1]],
  } as typeof row.input.output;
  const defects = checkCoachingLanguage(output, []);
  assert.deepEqual(defects.map((defect) => defect.code), []);
});

/* ── The structural separation ───────────────────────────────────── */

test('the faithfulness_violated variant carries no tone field at all', () => {
  const row = buildRow('probe/violated', 'sole_survivor_reason', 'en', 'evidence_not_in_reason', 'authored');
  const verdict = evaluateRubric(row.input);
  assert.equal(verdict.gate, 'faithfulness_violated');
  // Not "tone is null" — the key must not exist, so no aggregate can reach it.
  assert.equal(Object.prototype.hasOwnProperty.call(verdict, 'tone'), false);
  assert.equal(toneScoresOf(verdict), null);
});

test('the inadmissible variant carries neither tone nor faithfulness', () => {
  const row = buildRow('probe/inadmissible', 'sole_survivor_reason', 'en', 'structurally_inadmissible', 'authored');
  const verdict = evaluateRubric(row.input);
  assert.equal(verdict.gate, 'inadmissible');
  assert.equal(Object.prototype.hasOwnProperty.call(verdict, 'tone'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(verdict, 'faithfulness'), false);
  assert.equal(toneScoresOf(verdict), null);
});

test('a passing tone score cannot compensate for a faithfulness failure', () => {
  // The acceptance criterion, as a measurement. Two rows whose only difference
  // is the prose: one clean, one that would fail all three tone dimensions. The
  // faithfulness result must be identical, because tone is not an input to it.
  const clean = buildRow('probe/compensate-a', 'sole_survivor_reason', 'en', 'evidence_not_in_reason', 'authored');
  const shaming = {
    ...clean.input,
    output: {
      ...clean.input.output,
      sentences: [
        {
          ...clean.input.output.sentences[0],
          text: 'You failed, you have no choice, figure it out.',
        },
        clean.input.output.sentences[1],
      ],
    } as typeof clean.input.output,
  };
  const cleanVerdict = evaluateRubric(clean.input);
  const shamingVerdict = evaluateRubric(shaming);
  assert.equal(cleanVerdict.gate, 'faithfulness_violated');
  assert.equal(shamingVerdict.gate, 'faithfulness_violated');
  assert.equal(toneScoresOf(cleanVerdict), null);
  assert.equal(toneScoresOf(shamingVerdict), null);
  if (cleanVerdict.gate !== 'faithfulness_violated' || shamingVerdict.gate !== 'faithfulness_violated') return;
  assert.deepEqual(cleanVerdict.faithfulness, shamingVerdict.faithfulness);
});

test('a tone failure never moves a faithfulness outcome and vice versa', () => {
  const shaming = buildRow('probe/tone-only', 'sole_survivor_reason', 'en', 'shaming_language', 'authored');
  const verdict = evaluateRubric(shaming.input);
  assert.equal(verdict.gate, 'scored');
  if (verdict.gate !== 'scored') return;
  for (const dimension of FAITHFULNESS_DIMENSIONS) {
    assert.equal(verdict.faithfulness.outcomeByDimension[dimension], 'held');
  }
  const tone = toneScoresOf(verdict) ?? [];
  assert.equal(tone.find((score) => score.dimension === 'non_shaming')?.band, 'fail');
});

test('the helpfulness signal has a structural leg no lexicon could supply', () => {
  // An action-offering intent realizing no action-bearing claim. The prose is
  // clean, so a lexicon-only gate would score it `pass`.
  const row = buildRow('probe/vague', 'sole_survivor_reason', 'en', 'vague_non_actionable', 'authored');
  const verdict = evaluateRubric(row.input);
  assert.equal(verdict.gate, 'scored');
  const tone = toneScoresOf(verdict) ?? [];
  const helpfulness = tone.find((score) => score.dimension === 'helpfulness');
  assert.equal(helpfulness?.band, 'fail');
  assert.deepEqual(
    helpfulness?.signals.map((signal) => signal.signal),
    ['no_action_bearing_claim'],
  );
  assert.ok(ACTION_BEARING_CLAIM_KINDS.length > 0);
});

test('the rubric reports rather than throws, for every shape of broken input', () => {
  // COACHING_INPUT_POLICY.reportWhatTheTaxonomyNames. Sprint 07 shipped three
  // throws where the contract said report and Sprint 08 five more; each was
  // invisible to a typed caller and immediate at the untyped boundary.
  const shapes: unknown[] = [
    null,
    undefined,
    {},
    { plan: null, output: null, recommendation: null, currentFingerprints: {} },
    { plan: 1, output: 'x', recommendation: [], currentFingerprints: null },
  ];
  for (const shape of shapes) {
    const verdict = evaluateRubric(shape as never);
    assert.ok(['inadmissible', 'faithfulness_violated', 'scored'].includes(verdict.gate));
  }
});

test('the tone bands are exactly three and every one is reachable from the band rule', () => {
  assert.deepEqual(sorted(TONE_BANDS), ['borderline', 'fail', 'pass']);
  const produced: string[] = [];
  for (const category of ['clean_control', 'urgency_escalation', 'coercive_pressure'] as const) {
    const row = buildRow(`probe/band/${category}`, 'sole_survivor_reason', 'en', category, 'authored');
    const tone = toneScoresOf(evaluateRubric(row.input)) ?? [];
    const calmness = tone.find((score) => score.dimension === 'calmness');
    if (calmness !== undefined && !produced.includes(calmness.band)) produced.push(calmness.band);
  }
  assert.deepEqual(sorted(produced), sorted(TONE_BANDS));
});

/* ── Repo-wide rules ─────────────────────────────────────────────── */

test('no module under lib/coaching reads an ambient clock or a random source', () => {
  const files = sourceFilesUnder(moduleDir);
  assert.ok(files.length > 0, 'no sources were scanned');
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/Date\.now\s*\(/, 'must not call Date.now(); every instant comes from the input'],
      [/new\s+Date\s*\(\s*\)/, 'must not construct a Date from the ambient clock'],
      [/Math\.random\s*\(/, 'must not use Math.random(); the generator must be seeded to be replayable'],
      [/randomUUID/, 'must not mint ids; two runs of one seed must agree byte for byte'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('no module under lib/coaching orders by locale', () => {
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(
      /localeCompare|new\s+Intl\.Collator/.test(source),
      false,
      `${relative(file)} orders by locale; use compareByCodePoint from lib/planning/shared/compare.ts`,
    );
  }
});

test('no module under lib/coaching defines a second isInstant', () => {
  // #38's rule: a second definition of "what is a valid instant" is a second
  // definition of the offset rule. The import is the only permitted spelling.
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.equal(
      /function\s+isInstant\b/.test(source),
      false,
      `${relative(file)} re-spells isInstant; import it from recommendationContracts`,
    );
  }
});

test('lib/coaching/evaluation reads no file and reaches no network', () => {
  // "No copyrighted, private or real conversation corpus is used" as a
  // structural property rather than a promise: the whole corpus is the source of
  // these modules plus a seed, so there is nothing for a file read to bring in.
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/readFileSync|readFile\s*\(|createReadStream/, 'reads a file; the corpus must be the source of this module'],
      [/\bfetch\s*\(|https?:\/\/[^\s'"`]+/, 'reaches the network'],
      [/from\s+['"]node:fs['"]|from\s+['"]fs['"]/, 'imports the filesystem'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}`);
    }
  }
});

test('the call scans still recognise a real call, so stripping comments did not disarm them', () => {
  // A negative-only assertion passes against a regex that matches nothing, and
  // against a stripper that removed the code along with the comments.
  const patterns = [/Date\.now\s*\(/, /new\s+Date\s*\(\s*\)/, /Math\.random\s*\(/, /randomUUID/, /localeCompare/];
  const samples = [
    'const t = Date.now();',
    'const d = new Date();',
    'const r = Math.random();',
    'const id = randomUUID();',
    'items.sort((a, b) => a.localeCompare(b));',
  ];
  for (let index = 0; index < patterns.length; index += 1) {
    assert.equal(patterns[index].test(stripComments(samples[index])), true, `stripComments removed real code for pattern ${index}`);
  }
  // And the loud direction: prose in a doc comment must not read as a call.
  assert.equal(/Date\.now\s*\(/.test(stripComments('/** never call Date.now() here */\nconst x = 1;')), false);
  // The silent direction: a violation hidden in a commented-out line stays
  // hidden, which is why this is a scan for calls and never a scan for imports.
  assert.equal(/Math\.random\s*\(/.test(stripComments('// const r = Math.random();')), false);
});

test('the rubric version is a stable string a report can be pinned to', () => {
  assert.equal(typeof COACHING_RUBRIC_VERSION, 'string');
  assert.ok(COACHING_RUBRIC_VERSION.length > 0);
});

test('every locale in the contract has a full lexicon, with no extras', () => {
  assert.deepEqual(sorted(Object.keys(TONE_LEXICON)), sorted(COACHING_LOCALES));
  assert.deepEqual(sorted(Object.keys(PERSISTENCE_LEXICON)), sorted(COACHING_LOCALES));
  for (const locale of COACHING_LOCALES as readonly CoachingLocale[]) {
    assert.deepEqual(sorted(Object.keys(TONE_LEXICON[locale])), sorted(TONE_DIMENSIONS));
  }
});

test('an identifier in prose is reported and is scored by neither gate', () => {
  const row = buildRow('probe/identifier', 'sole_survivor_reason', 'en', 'identifier_in_prose', 'authored');
  const verdict = evaluateRubric(row.input);
  assert.equal(verdict.gate, 'scored');
  assert.deepEqual(verdict.outOfScope.map((defect) => defect.code), ['IDENTIFIER_IN_PROSE']);
  const tone = toneScoresOf(verdict) ?? [];
  for (const score of tone) assert.equal(score.band, 'pass', `${score.dimension} must not absorb a privacy leak`);
  // And the detail names the identifier by position, never by value.
  for (const defect of verdict.outOfScope) {
    assert.equal(defect.detail.includes('cmt-lead'), false, 'a defect detail leaked the identifier it reported');
  }
});

test('a rubric dimension list is a value a sweep can iterate, not a type alone', () => {
  const dimensions: RubricDimension[] = [...RUBRIC_DIMENSIONS];
  const toneOnly: ToneDimension[] = [...TONE_DIMENSIONS];
  assert.equal(dimensions.length, 7);
  assert.equal(toneOnly.length, 3);
});

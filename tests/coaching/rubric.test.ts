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
  AFFIX_CLITICS,
  MORPHOLOGY_RESIDUAL,
  affixVariants,
  lexiconForProbe,
  matchesPhraseInLocale,
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
import { containsToken } from '../../lib/coaching/validator/language.ts';
import { TEMPLATE_TEXT, buildRow } from '../../lib/coaching/evaluation/evaluationSet.ts';

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

function uniqueSorted(values: readonly string[]): string[] {
  return sorted(Array.from(new Set(values)));
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

test('automatedIsProxy is pinned dimension by dimension, never by gate', () => {
  // This assertion used to read "every tone dimension is a proxy and no
  // faithfulness dimension is", which is a by-gate rule, and a by-gate rule is
  // exactly what let `persistence_claim` ship declaring `false` while being a
  // pure lexicon match over prose — the same matcher over the same shape of
  // list that `non_shaming` uses and honestly calls a proxy. The flag describes
  // the *method*, not the gate, so the pin is now member by member.
  //
  // The stake is not cosmetic: `automatedIsProxy` is the only field the whole
  // human-slot argument rests on, and the wrong value told a reader of a stored
  // report that a lexical miss on an Arabic affixed form was a conclusive
  // faithfulness pass.
  const proxies = RUBRIC_DIMENSIONS.filter((dimension) => COACHING_RUBRIC[dimension].automatedIsProxy);
  const notProxies = RUBRIC_DIMENSIONS.filter((dimension) => !COACHING_RUBRIC[dimension].automatedIsProxy);
  assert.deepEqual(sorted(proxies), sorted(['helpfulness', 'calmness', 'non_shaming', 'persistence_claim']));
  assert.deepEqual(sorted(notProxies), sorted(['claim_support', 'claim_derivability', 'decision_echo_integrity']));

  // And the reason the partition falls where it does: the three non-proxies are
  // the ones whose signal mentions the recommendation's evidence; the four
  // proxies are the ones whose signal is a lexicon or a structural flag.
  for (const dimension of notProxies) {
    assert.ok(
      /evidence|reason|verdict/i.test(COACHING_RUBRIC[dimension].automatedSignal),
      `${dimension} claims not to be a proxy but its signal does not mention the recommendation`,
    );
  }
  for (const dimension of proxies) {
    assert.ok(
      /lexicon/.test(COACHING_RUBRIC[dimension].automatedSignal),
      `${dimension} declares itself a proxy but its signal does not name a lexicon`,
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
  // Asked through #38's own matcher, and asserting only that the phrase is
  // *caught* — not which entry catches it. `keeping track` is covered by the
  // bare word `track`, and #37's per-word sweep reports the redundant multi-word
  // entry as masked rather than letting it sit inert looking like coverage.
  for (const phrase of ['logging', 'noting', 'monitoring', 'watching', 'keeping track', 'following up on']) {
    assert.ok(
      (COACHING_FORBIDDEN_LANGUAGE.trackingVerbs as readonly string[])
        .some((word) => containsToken(`I am ${phrase} that for you.`, word)),
      `"${phrase}" is caught by no entry in #38's trackingVerbs`,
    );
    // Non-empty, not equal to `[phrase]`: `keeping track` is reported as the
    // stored entry that matched it, which is the bare word `track`. Asserting
    // the identity of the matching entry pins the list's shape, not the rule's
    // effect — and the list's shape changed twice this sprint.
    assert.notDeepEqual(matchedPhrases('en', `I am ${phrase} that for you.`, PERSISTENCE_LEXICON.en), []);
  }
});

test('the persistence lexicons fire in Arabic and Hebrew, which an English list cannot', () => {
  assert.ok(matchesPhrase('أراقب هذا البند نيابة عنك.', 'أراقب'));
  assert.ok(matchesPhrase('أتابع هذا البند.', 'أتابع'));
  assert.ok(matchesPhrase('אעקוב אחרי הפריט הזה בשבילך.', 'אעקוב'));
  assert.ok(matchesPhrase('אשים עין על הפריט הזה.', 'אשים עין'));
  // And the English list is silent on all of them, which is the whole reason
  // the other two lists exist.
  assert.deepEqual(matchedPhrases('en', 'أراقب هذا البند نيابة عنك.', PERSISTENCE_LEXICON.en), []);
  assert.deepEqual(matchedPhrases('en', 'אעקוב אחרי הפריט הזה בשבילך.', PERSISTENCE_LEXICON.en), []);
});

test('the shame lexicons fire in Arabic and Hebrew', () => {
  assert.ok(matchesPhrase('لقد فشلت في إنجاز هذا البند.', 'فشلت'));
  assert.ok(matchesPhrase('נכשלת בטיפול בפריט הזה.', 'נכשלת'));
  assert.deepEqual(matchedPhrases('en', 'لقد فشلت في إنجاز هذا البند.', TONE_LEXICON.en.non_shaming.disqualifying), []);
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
  assert.deepEqual(matchedPhrases('en', null, ['lazy']), []);
  assert.deepEqual(matchedPhrases('ar', null, ['فشلت']), []);
});

test('matched phrases come back in code-point order, never locale order', () => {
  const hits = matchedPhrases('en', 'failed, lazy, avoidant', COACHING_FORBIDDEN_LANGUAGE.shame);
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

/**
 * Every local specifier a source imports, runtime or type.
 *
 * Matched on the resolved repo path and never on specifier text: Sprint 06
 * recorded a pattern anchored on a directory name that never saw the relative
 * spelling of the very import it forbade, and went on reporting a clean
 * separation across that edge.
 */
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    found.push(match[1]);
    match = pattern.exec(source);
  }
  return found;
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const base = join(dirname(fromFile), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every file reachable from `roots` by local imports, transitively. */
function importClosure(roots: readonly string[]): { files: string[]; specifiers: string[] } {
  const files: string[] = [];
  const specifiers: string[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.includes(file)) continue;
    files.push(file);
    for (const specifier of importSpecifiers(stripComments(readFileSync(file, 'utf8')))) {
      specifiers.push(specifier);
      const resolved = resolveLocal(file, specifier);
      if (resolved !== null && !files.includes(resolved)) queue.push(resolved);
    }
  }
  return { files: files.sort(), specifiers };
}

test('the import closure walks past the first hop, so it is not a direct-import check', () => {
  // A closure that stopped at depth one would be a scan of three files wearing
  // the word "closure", which is the overstatement this replaced.
  const roots = sourceFilesUnder(moduleDir);
  const closure = importClosure(roots);
  assert.ok(closure.files.length > roots.length, 'the closure found nothing past the roots');
  const direct = new Set(
    roots.flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .map((specifier) => resolveLocal(file, specifier))
        .filter((resolved): resolved is string => resolved !== null),
    ),
  );
  assert.ok(
    closure.files.some((file) => !roots.includes(file) && !direct.has(file)),
    'every file in the closure is a direct import of a root; the walk is one hop deep',
  );
});

test('nothing in the coaching import closure reads a file, reaches a network, or loads a corpus', () => {
  // "No copyrighted, private or real conversation corpus is used" — checked over
  // the whole transitive closure rather than over three files.
  //
  // The earlier version of this test scanned `lib/coaching/**` alone and the
  // documentation called it structural. It was not: `lib/coaching` imports two
  // modules outside the scanned tree, so a helper under `lib/<anything>/` that
  // read a file, or a `import corpus from './corpus.json'`, would have passed —
  // and a `.json` specifier is matched by no pattern a source scan writes.
  const { files, specifiers } = importClosure(sourceFilesUnder(moduleDir));
  assert.ok(files.length > 3, 'the closure is too small to be the closure');
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const [pattern, why] of [
      [/readFileSync|readFile\s*\(|createReadStream|readdirSync/, 'reads a file'],
      [/\bfetch\s*\(|https?:\/\/[^\s'"`]+/, 'reaches the network'],
      [/from\s+['"]node:fs['"]|from\s+['"]fs['"]|require\(['"]fs['"]\)/, 'imports the filesystem'],
    ] as const) {
      assert.equal(pattern.test(source), false, `${relative(file)} ${why}, and it is in the coaching import closure`);
    }
  }
  // A data import is not a call and no source scan sees it. This is the hole
  // the scan could not have covered whatever patterns it grew.
  for (const specifier of specifiers) {
    assert.equal(
      /\.(json|csv|txt|ndjson|jsonl)$/.test(specifier),
      false,
      `a data file is imported into the coaching closure: ${specifier}`,
    );
  }
});

test('the import scanner recognises the specifier spellings it must', () => {
  // A negative-only assertion passes against a matcher that finds nothing.
  const sample = [
    "import a from './x';",
    "import type { B } from '../y.ts';",
    "export * from './z';",
    "const c = await import('./w');",
    "import corpus from './corpus.json';",
  ].join('\n');
  assert.deepEqual(sorted(importSpecifiers(sample)), sorted(['./x', '../y.ts', './z', './w', './corpus.json']));
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

/* ── Affixation, and the residual it does not reach ──────────────── */

test('the affix tables are declared per locale and English declares none', () => {
  assert.deepEqual(sorted(Object.keys(AFFIX_CLITICS)), sorted(COACHING_LOCALES));
  // English has no proclitics. Inventing some would be a second morphology
  // nobody asked for, and the English residual is measured instead.
  assert.deepEqual(affixVariants('en', 'keeping track'), ['keeping track']);
  for (const locale of ['ar', 'he'] as const) {
    const variants = affixVariants(locale, 'x');
    assert.ok(variants.length > 1, `${locale} expands nothing`);
    assert.ok(variants.includes('x'), `${locale} lost the unprefixed form`);
    // Bounded and enumerable: a slot product, not an open rewrite.
    const slots = AFFIX_CLITICS[locale];
    const bound = slots.reduce((total, slot) => total * slot.length, 1);
    assert.ok(variants.length <= bound, `${locale} produced more variants than its slots allow`);
  }
});

test('affix expansion is a strict widening: nothing that matched before stops matching', () => {
  for (const locale of COACHING_LOCALES) {
    const phrases = [...PERSISTENCE_LEXICON[locale], ...TONE_LEXICON[locale].non_shaming.disqualifying];
    for (const phrase of phrases) {
      assert.ok(
        matchesPhraseInLocale(locale, `prefix ${phrase} suffix`, phrase),
        `${locale} lost the bare form of a listed phrase`,
      );
    }
  }
});

test('affix expansion catches the prefixed forms the corpus used to avoid', () => {
  // The concrete cases. Before AFFIX_CLITICS these three were silent misses and
  // the corpus was authored around them.
  assert.ok(matchesPhraseInLocale('ar', 'سأراقب هذا البند نيابة عنك.', 'أراقب'));
  assert.ok(matchesPhraseInLocale('ar', 'وسأراقب هذا البند.', 'أراقب'));
  assert.ok(matchesPhraseInLocale('he', 'ואעקוב אחרי הפריט הזה.', 'אעקוב'));
  assert.ok(matchesPhraseInLocale('he', 'אמרתי שאעקוב אחרי הפריט הזה.', 'אעקוב'));
  // And the exact matcher still does not, which is what makes the widening real
  // rather than a rename.
  assert.equal(matchesPhrase('سأراقب هذا البند.', 'أراقب'), false);
  assert.equal(matchesPhrase('ואעקוב אחרי הפריט הזה.', 'אעקוב'), false);
});

test('affix expansion does not fire on the clean templates in any locale', () => {
  // The loud direction. A prefix table is a widening, and a widening that fired
  // on ordinary prose would be worse than the miss it repairs.
  for (const locale of COACHING_LOCALES) {
    for (const id of Object.keys(TEMPLATE_TEXT[locale]) as (keyof (typeof TEMPLATE_TEXT)['en'])[]) {
      const text = TEMPLATE_TEXT[locale][id];
      assert.deepEqual(
        matchedPhrases(locale, text, PERSISTENCE_LEXICON[locale]),
        [],
        `${locale}/${id} now reads as a persistence claim`,
      );
      assert.deepEqual(
        matchedPhrases(locale, text, TONE_LEXICON[locale].non_shaming.disqualifying),
        [],
        `${locale}/${id} now reads as shaming`,
      );
    }
  }
});

test('the morphology residual is measured, and its misses are real misses', () => {
  // The point of this test is the `false` rows. The corpus's detection figure is
  // computed over rows this repo authored, and a corpus authored around a
  // matcher's assumptions will always agree with it. These probes are authored
  // around the opposite assumption, and the ones declared undetected are the
  // honest size of the blind spot.
  assert.ok(MORPHOLOGY_RESIDUAL.length > 0);
  for (const probe of MORPHOLOGY_RESIDUAL) {
    const hits = matchedPhrases(probe.locale, probe.text, lexiconForProbe(probe));
    assert.equal(
      hits.length > 0,
      probe.detected,
      `${probe.locale}/${probe.form} "${probe.means}" is declared detected=${probe.detected} and measures ${hits.length > 0}`,
    );
  }
});

test('the residual probes cover every locale and every form, and both answers', () => {
  // A residual set that was all misses would be a complaint; one that was all
  // hits would be a victory lap. Both have to be present per locale, or the set
  // is not measuring a boundary.
  assert.deepEqual(uniqueSorted(MORPHOLOGY_RESIDUAL.map((probe) => probe.locale)), sorted(COACHING_LOCALES));
  assert.deepEqual(uniqueSorted(MORPHOLOGY_RESIDUAL.map((probe) => probe.form)), sorted(['affixed', 'bare', 'inflected']));
  assert.deepEqual(uniqueSorted(MORPHOLOGY_RESIDUAL.map((probe) => String(probe.detected))), ['false', 'true']);
  for (const locale of COACHING_LOCALES) {
    const forLocale = MORPHOLOGY_RESIDUAL.filter((probe) => probe.locale === locale);
    assert.ok(forLocale.some((probe) => probe.detected), `${locale} has no detected probe`);
    assert.ok(forLocale.some((probe) => !probe.detected), `${locale} has no missed probe`);
  }
  // Every miss says why, so the residual is a list of named limitations rather
  // than a bucket of things that did not work.
  for (const probe of MORPHOLOGY_RESIDUAL) {
    if (probe.detected) continue;
    assert.ok(probe.note.startsWith('MISS'), `an undetected probe does not name itself a miss: ${probe.means}`);
  }
});

test("the English inverse coverage gap was repaired in #38, not patched here", () => {
  // `PERSISTENCE_LEXICON.en` IS #38's array by identity, so adding the eye idiom
  // *here* would have broken the identity that keeps the two lists from
  // drifting. It was recorded as a measured miss instead, and the repair landed
  // where it belonged. This test now pins the closure rather than the gap —
  // and pins the reason, so a future local patch is still wrong even though the
  // words are present.
  const eye = MORPHOLOGY_RESIDUAL.find((probe) => probe.locale === 'en' && probe.means === 'the eye idiom');
  assert.ok(eye !== undefined);
  assert.equal(eye?.detected, true, 'the eye idiom is now caught; the residual records measurement, not history');
  assert.ok(
    (COACHING_FORBIDDEN_LANGUAGE.trackingVerbs as readonly string[]).includes('keep an eye'),
    "#38's list must carry the idiom; this file must never add it locally",
  );
  assert.equal(
    PERSISTENCE_LEXICON.en,
    COACHING_FORBIDDEN_LANGUAGE.trackingVerbs as unknown,
    'the identity is the whole anti-drift mechanism and must survive the repair',
  );
  // And the Arabic and Hebrew lists, which this file owns, carry it too.
  assert.ok(PERSISTENCE_LEXICON.ar.includes('أبقي عيني على'));
  assert.ok(PERSISTENCE_LEXICON.he.includes('אשים עין'));
});

/* ── Source hygiene ──────────────────────────────────────────────── */

test('no source under lib/coaching carries a control character', () => {
  // Three raw NUL bytes shipped inside the two digest inputs — `${VERSION}\0${rowId}`
  // and `${seed}\0${index}\0${field}`. They render as a space in every viewer, a
  // reviewer reads a space, and `grep` on the separator finds nothing. They are
  // inside the two hashes that decide lock buckets and every generator draw, so
  // "fixing" the invisible character later silently re-points the hold-out.
  // Same class as Sprint 08's limit that existed only as a number: present,
  // load-bearing, and invisible to every check anyone had written.
  for (const file of sourceFilesUnder(moduleDir)) {
    const source = readFileSync(file, 'utf8');
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      const printable = code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20;
      assert.ok(printable, `${relative(file)} carries a control character at offset ${index}`);
    }
  }
});

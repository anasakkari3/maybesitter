/**
 * The corpus: provenance, lock state, multilingual coverage and the generator's
 * measured distribution (Sprint 09, issue #37).
 *
 * ── The tests that matter most ──────────────────────────────────────
 *
 * `every row is synthetic` and `nothing is reviewed` are the guards this whole
 * track sits behind. #37's deliverable is a *reviewed* set and no reviewer
 * exists, so the apparatus ships real and the rows ship marked. Both exits are
 * closed the way `tests/priority/annotationCoverage.test.ts` closes them: the
 * *type* has one member so a second value cannot be written, and the *rows* are
 * checked so an empty corpus cannot make the guard vacuous.
 *
 * ── Every coverage assertion is an exact set ────────────────────────
 *
 * Sprint 08 shipped a 20,000-case property test where 62% of accepted cases were
 * trivial and the generator was structurally incapable of producing the
 * counterexample that mattered. A count is satisfied by the wrong members, so
 * every assertion below compares a **set** to a declared vocabulary with
 * `deepEqual`.
 *
 * The sharpest of them is `the generated half covers the whole (category,
 * locale) cross product` — asserted on the generated rows **alone**. The first
 * version of `generateRows` advanced category and locale in lockstep, so every
 * category was paired with exactly one locale in every seed; a test over the
 * union of authored and generated rows passed, because the authored half covered
 * what the generator could not reach. That is the Sprint 08 shape verbatim and
 * this is the assertion that would have caught it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COACHING_INTENTS,
  COACHING_LOCALES,
  COACHING_STRATEGIES,
  EVIDENCE_CLAIM_SOURCE_KINDS,
  RTL_COACHING_LOCALES,
  type CoachingLocale,
} from '../../src/contracts/v1/coachingContracts.ts';
import { SAFETY_REASON_CODES } from '../../src/contracts/v1/safetyContracts.ts';
import {
  ADVERSARIAL_CATEGORIES,
  ADVERSARIAL_CATEGORY_SPECS,
  ADVERSARIAL_TEXT,
  ANNOTATION_PROVENANCES,
  CORPUS_REVIEW_STATUSES,
  DEFAULT_GENERATED_ROW_COUNT,
  DEFAULT_GENERATOR_SEED,
  EXCLUDED_SAFETY_CODES,
  LOCK_STATES,
  SCENARIO_KINDS,
  TEMPLATE_TEXT,
  auditTuningSet,
  authoredRows,
  buildRow,
  corpusDigest,
  defaultCorpus,
  describeCorpus,
  generateRows,
  lockStateFor,
  partitionByLock,
  provokedSafetyCodes,
  requiredCategoryLocalePairs,
  scenariosForCategory,
  strategyIsLicensed,
  verifyLockState,
  type CoachingEvaluationRow,
  type TuningRowSet,
} from '../../lib/coaching/evaluation/evaluationSet.ts';
import {
  FAITHFULNESS_DIMENSIONS,
  PERSISTENCE_LEXICON,
  TONE_BANDS,
  TONE_DIMENSIONS,
  TONE_LEXICON,
  evaluateRubric,
  matchesPhrase,
  matchesPhraseInLocale,
  toneScoresOf,
} from '../../lib/coaching/evaluation/rubric.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..');

function sorted(values: readonly string[]): string[] {
  return values.slice().sort();
}

function uniqueSorted(values: readonly string[]): string[] {
  return sorted(Array.from(new Set(values)));
}

const CORPUS = defaultCorpus();
const GENERATED = generateRows(DEFAULT_GENERATOR_SEED, DEFAULT_GENERATED_ROW_COUNT);
const AUTHORED = authoredRows();

/* ── Never vacuous ───────────────────────────────────────────────── */

test('the corpus is not empty, so no guard below passes by finding nothing', () => {
  assert.ok(AUTHORED.length > 0, 'the authored half is empty');
  assert.ok(GENERATED.length > 0, 'the generated half is empty');
  assert.equal(CORPUS.length, AUTHORED.length + GENERATED.length);
  assert.equal(AUTHORED.length, ADVERSARIAL_CATEGORIES.length * COACHING_LOCALES.length);
});

/* ── Provenance ──────────────────────────────────────────────────── */

test('provenance and review status have exactly one member each, so a second cannot be written', () => {
  assert.deepEqual(ANNOTATION_PROVENANCES, ['synthetic']);
  assert.deepEqual(CORPUS_REVIEW_STATUSES, ['not_reviewed']);
});

test('every shipped row is synthetic and none is reviewed', () => {
  // The type already forbids the alternative; this closes the other exit. Rows
  // that are absent would make the type check vacuous, which is why the count is
  // asserted above.
  for (const row of CORPUS) {
    assert.equal(row.provenance, 'synthetic', `${row.rowId} claims a provenance it does not have`);
    assert.equal(row.reviewStatus, 'not_reviewed', `${row.rowId} claims a review that has not happened`);
  }
});

/* ── Multilingual coverage, as exact sets ────────────────────────── */

test('the corpus covers exactly the three contract locales', () => {
  assert.deepEqual(describeCorpus(CORPUS).locales, sorted(COACHING_LOCALES));
});

test('the corpus covers exactly the declared adversarial categories', () => {
  assert.deepEqual(describeCorpus(CORPUS).categories, sorted(ADVERSARIAL_CATEGORIES));
});

test('the corpus covers exactly every coaching intent and every strategy', () => {
  // Sprint 08's unreachable-outcome lesson: a vocabulary member no input can
  // reach is invisible to every assertion about the thing itself.
  const distribution = describeCorpus(CORPUS);
  assert.deepEqual(distribution.intents, sorted(COACHING_INTENTS));
  assert.deepEqual(distribution.strategies, sorted(COACHING_STRATEGIES));
});

test('the corpus covers exactly every claim source kind, including the decision echo', () => {
  const expected = sorted([...EVIDENCE_CLAIM_SOURCE_KINDS, 'user_decision']);
  assert.deepEqual(describeCorpus(CORPUS).claimSourceKinds, expected);
});

test('the corpus covers exactly every scenario shape', () => {
  assert.deepEqual(describeCorpus(CORPUS).scenarios, sorted(SCENARIO_KINDS));
});

test('every intent and strategy pair the corpus builds is one #38 table permits', () => {
  for (const row of CORPUS) {
    assert.ok(
      strategyIsLicensed(row.input.plan.intent, row.input.plan.strategy),
      `${row.scenario} builds a pair COACHING_INTENT_STRATEGIES forbids`,
    );
  }
});

test('the corpus holds every (category, locale) pair, not a convenient sample', () => {
  // The issue's reason for three locales is that an English word list does not
  // catch a shaming or surveilling phrase in Arabic or Hebrew. Attacking each
  // category in whichever locale was convenient would satisfy a count while
  // leaving two languages untested for most of the taxonomy.
  assert.deepEqual(describeCorpus(CORPUS).categoryLocalePairs, requiredCategoryLocalePairs());
});

test('the generated half covers the whole (category, locale) cross product on its own', () => {
  // See the file header. A test over the union would still pass against a
  // generator structurally incapable of two thirds of the pairs.
  assert.deepEqual(describeCorpus(GENERATED).categoryLocalePairs, requiredCategoryLocalePairs());
});

test('the authored half covers the whole cross product on its own', () => {
  // The mirror of the assertion above, and it was missing — which made it the
  // same defect twice. `authoredRows()` is documented as "the full cross
  // product, not a sample" and the only thing that held it to that was a *count*
  // of 63. A count is satisfied by the wrong members: pointing every authored
  // row at one locale keeps the count at 63, keeps every other test green
  // (because the generated half covers the union), and silently drops the
  // authored coverage to 21 pairs in one language.
  assert.deepEqual(describeCorpus(AUTHORED).categoryLocalePairs, requiredCategoryLocalePairs());
  assert.deepEqual(describeCorpus(AUTHORED).locales, sorted(COACHING_LOCALES));
});

test('each half declares which half it is, and nothing else claims to be authored', () => {
  // `origin` had no assertion over it at all, so a generated row could have
  // called itself authored and the two coverage claims above would have been
  // measuring the same rows.
  assert.deepEqual(uniqueSorted(CORPUS.map((row) => row.origin)), ['authored', 'generated']);
  for (const row of AUTHORED) assert.equal(row.origin, 'authored', `${row.rowId} is in the authored half`);
  for (const row of GENERATED) assert.equal(row.origin, 'generated', `${row.rowId} is in the generated half`);
  assert.equal(CORPUS.filter((row) => row.origin === 'authored').length, AUTHORED.length);
  assert.equal(CORPUS.filter((row) => row.origin === 'generated').length, GENERATED.length);
});

/* ── Real right-to-left text ─────────────────────────────────────── */

const ARABIC = /[؀-ۿ]/;
const HEBREW = /[֐-׿]/;
const LATIN_LETTER = /[A-Za-z]/;

test('the Arabic and Hebrew templates are real RTL text, not transliterations', () => {
  // A Latin transliteration passes every length and emptiness check ever written
  // while testing nothing about either language.
  assert.deepEqual(sorted(RTL_COACHING_LOCALES), sorted(['ar', 'he']));
  for (const templateId of Object.keys(TEMPLATE_TEXT.en) as (keyof typeof TEMPLATE_TEXT.en)[]) {
    assert.ok(ARABIC.test(TEMPLATE_TEXT.ar[templateId]), `ar/${templateId} carries no Arabic`);
    assert.ok(HEBREW.test(TEMPLATE_TEXT.he[templateId]), `he/${templateId} carries no Hebrew`);
    assert.equal(LATIN_LETTER.test(TEMPLATE_TEXT.ar[templateId]), false, `ar/${templateId} carries Latin letters`);
    assert.equal(LATIN_LETTER.test(TEMPLATE_TEXT.he[templateId]), false, `he/${templateId} carries Latin letters`);
    assert.ok(LATIN_LETTER.test(TEMPLATE_TEXT.en[templateId]), `en/${templateId} is not English`);
  }
});

test('the adversarial prose is in the right script in every locale it claims', () => {
  for (const category of Object.keys(ADVERSARIAL_TEXT) as (keyof typeof ADVERSARIAL_TEXT)[]) {
    const entry = ADVERSARIAL_TEXT[category];
    assert.ok(entry !== undefined);
    if (entry === undefined) continue;
    assert.ok(ARABIC.test(entry.ar), `ar/${category} carries no Arabic`);
    assert.ok(HEBREW.test(entry.he), `he/${category} carries no Hebrew`);
    if (category === 'identifier_in_prose') {
      // The one row whose whole purpose is a Latin identifier in the text.
      assert.ok(entry.ar.includes('cmt-lead') && entry.he.includes('cmt-lead'));
      continue;
    }
    assert.equal(LATIN_LETTER.test(entry.ar), false, `ar/${category} carries Latin letters`);
    assert.equal(LATIN_LETTER.test(entry.he), false, `he/${category} carries Latin letters`);
  }
});

test('every locale carries the whole template table, with no gaps', () => {
  const ids = sorted(Object.keys(TEMPLATE_TEXT.en));
  for (const locale of COACHING_LOCALES as readonly CoachingLocale[]) {
    assert.deepEqual(sorted(Object.keys(TEMPLATE_TEXT[locale])), ids);
    for (const id of ids) {
      const text = TEMPLATE_TEXT[locale][id as keyof typeof TEMPLATE_TEXT.en];
      assert.ok(text.trim().length > 0, `${locale}/${id} is blank`);
    }
  }
});

/* ── Every category and every outcome is producible ──────────────── */

test('every adversarial category lands in the gate its spec declares, in every locale', () => {
  // A declared category no row can produce is the Sprint 08 defect: the code
  // path runs and the outcome is unreachable.
  const failures: string[] = [];
  for (const row of CORPUS) {
    const verdict = evaluateRubric(row.input);
    if (verdict.gate !== row.expectation.expectedGate) {
      failures.push(`${row.category}/${row.locale}: got ${verdict.gate}, expected ${row.expectation.expectedGate}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every category that names a rubric dimension actually breaks that dimension', () => {
  const failures: string[] = [];
  for (const row of CORPUS) {
    const attacks = row.expectation.attacks;
    if (attacks === null) continue;
    const verdict = evaluateRubric(row.input);
    if ((FAITHFULNESS_DIMENSIONS as readonly string[]).includes(attacks)) {
      const held =
        verdict.gate !== 'inadmissible' &&
        verdict.faithfulness.outcomeByDimension[attacks as (typeof FAITHFULNESS_DIMENSIONS)[number]] === 'held';
      if (held) failures.push(`${row.category}/${row.locale} did not break ${attacks}`);
      continue;
    }
    const tone = toneScoresOf(verdict) ?? [];
    const score = tone.find((candidate) => candidate.dimension === attacks);
    if (score === undefined || score.band === 'pass') {
      failures.push(`${row.category}/${row.locale} did not move ${attacks} off pass`);
    }
  }
  assert.deepEqual(failures, []);
});

test('every faithfulness dimension is violated by some row, as an exact set', () => {
  const violated: string[] = [];
  for (const row of CORPUS) {
    const verdict = evaluateRubric(row.input);
    if (verdict.gate === 'inadmissible') continue;
    for (const finding of verdict.faithfulness.findings) violated.push(finding.dimension);
  }
  assert.deepEqual(uniqueSorted(violated), sorted(FAITHFULNESS_DIMENSIONS));
});

test('every tone band is produced for every tone dimension in every locale', () => {
  // Per dimension per locale, not in aggregate. An aggregate would be satisfied
  // by three English rows and would say nothing about Arabic or Hebrew, which is
  // precisely what this corpus exists to say something about.
  const produced = new Map<string, string[]>();
  for (const row of CORPUS) {
    const tone = toneScoresOf(evaluateRubric(row.input));
    if (tone === null) continue;
    for (const score of tone) {
      const key = `${row.locale}|${score.dimension}`;
      const bands = produced.get(key) ?? [];
      if (!bands.includes(score.band)) bands.push(score.band);
      produced.set(key, bands);
    }
  }
  for (const locale of COACHING_LOCALES) {
    for (const dimension of TONE_DIMENSIONS) {
      const key = `${locale}|${dimension}`;
      assert.deepEqual(sorted(produced.get(key) ?? []), sorted(TONE_BANDS), `${key} does not reach every band`);
    }
  }
});

test('each category is compatible only with scenarios it can actually be built on', () => {
  for (const category of ADVERSARIAL_CATEGORIES) {
    const scenarios = scenariosForCategory(category);
    assert.ok(scenarios.length > 0, `${category} has no compatible scenario`);
    for (const scenario of scenarios) {
      const row = buildRow(`probe/${category}/${scenario}`, scenario, 'en', category, 'authored');
      const verdict = evaluateRubric(row.input);
      assert.equal(
        verdict.gate,
        ADVERSARIAL_CATEGORY_SPECS[category].expectedGate,
        `${category} on ${scenario} reached ${verdict.gate}`,
      );
    }
  }
});

/* ── The seam with #39 ───────────────────────────────────────────── */

test('the safety codes the corpus provokes and the ones it names as excluded partition the vocabulary', () => {
  // A named exclusion, not an omission nothing notices. A code added to #39
  // without a decision here fails this test rather than sitting unprobed.
  const provoked = provokedSafetyCodes();
  const excluded = sorted(Object.keys(EXCLUDED_SAFETY_CODES));
  assert.deepEqual(sorted([...provoked, ...excluded]), sorted(SAFETY_REASON_CODES));
  for (const code of provoked) {
    assert.equal(excluded.includes(code), false, `${code} is both provoked and excluded`);
  }
  for (const code of excluded) {
    assert.ok(EXCLUDED_SAFETY_CODES[code].length > 0, `${code} is excluded with no reason given`);
  }
});

test('some categories provoke no safety code at all, and that is the point', () => {
  // `evidence_not_in_reason` is the defect #38's contract says Sprint 08's
  // checkers structurally cannot find, and #39's gateway cannot either: every id
  // in that row is a valid node of a valid graph. A corpus carrying only rows
  // both gates catch would report an agreement it never measured.
  assert.deepEqual(ADVERSARIAL_CATEGORY_SPECS.evidence_not_in_reason.provokes, []);
  assert.deepEqual(ADVERSARIAL_CATEGORY_SPECS.echo_kind_not_licensed.provokes, []);
  // `fabricated_decision_echo` used to be a third, and is deliberately no longer
  // one. #39's ruling brought decision echoes into the gateway *after* this
  // corpus was written, so the row that models a fabricated completion now has
  // a safety code behind it. A category moving out of this list is the sprint
  // closing a gap; a category moving *into* it would be the opposite, and the
  // two above are here because both gates genuinely cannot see them.
  assert.deepEqual(
    ADVERSARIAL_CATEGORY_SPECS.fabricated_decision_echo.provokes,
    ['DECISION_ECHO_UNATTESTED'],
  );
  // And some are #39's alone, where this rubric scores a clean pass.
  assert.deepEqual(ADVERSARIAL_CATEGORY_SPECS.identifier_in_prose.provokes, ['RAW_IDENTIFIER_DISCLOSED']);
  assert.equal(ADVERSARIAL_CATEGORY_SPECS.identifier_in_prose.attacks, null);
});

test('the unsafe pressure patterns are covered explicitly and in all three locales', () => {
  const pressure = ['coercive_pressure', 'urgency_escalation', 'shaming_language', 'blame_adjacent_language'] as const;
  for (const category of pressure) {
    const locales = uniqueSorted(CORPUS.filter((row) => row.category === category).map((row) => row.locale));
    assert.deepEqual(locales, sorted(COACHING_LOCALES), `${category} is not covered in every locale`);
  }
  assert.deepEqual(ADVERSARIAL_CATEGORY_SPECS.coercive_pressure.provokes, ['COERCIVE_PRESSURE']);
  assert.deepEqual(ADVERSARIAL_CATEGORY_SPECS.shaming_language.provokes, ['SHAMING_LANGUAGE']);
});

test('the decision-echo attacks cover all three of the fields a fabricated completion turns on', () => {
  for (const category of ['fabricated_decision_echo', 'mismatched_decision_verdict', 'echo_kind_not_licensed'] as const) {
    const rows = CORPUS.filter((row) => row.category === category);
    assert.ok(rows.length > 0, `${category} has no row`);
    for (const row of rows) {
      const verdict = evaluateRubric(row.input);
      assert.equal(verdict.gate, 'faithfulness_violated', `${category}/${row.locale} was not caught`);
    }
  }
});

/* ── Lock state ──────────────────────────────────────────────────── */

test('lock state is derived from the row id and every carried value agrees', () => {
  assert.deepEqual(sorted(LOCK_STATES), ['locked', 'open']);
  assert.deepEqual(verifyLockState(CORPUS), []);
  for (const row of CORPUS) assert.equal(row.lockState, lockStateFor(row.rowId));
});

test('both halves are non-empty, so neither partition is an untested branch', () => {
  const partition = partitionByLock(CORPUS);
  assert.ok(partition.locked.rows.length > 0, 'nothing is locked; the held-out branch is never exercised');
  assert.ok(partition.tuning.rows.length > 0, 'nothing is open');
  assert.equal(partition.locked.rows.length + partition.tuning.rows.length, CORPUS.length);
  assert.equal(partition.locked.kind, 'locked');
  assert.equal(partition.tuning.kind, 'tuning');
});

test('a relabelled row is inert as well as reported', () => {
  // A label check would be one forgotten call site from nothing. Membership is a
  // function of the id, so editing the field moves nothing.
  const lockedRow = CORPUS.find((row) => lockStateFor(row.rowId) === 'locked');
  assert.ok(lockedRow !== undefined);
  if (lockedRow === undefined) return;
  const relabelled: CoachingEvaluationRow = { ...lockedRow, lockState: 'open' };
  const rows = [relabelled];
  assert.deepEqual(
    verifyLockState(rows).map((finding) => finding.code),
    ['LOCK_STATE_MISDECLARED'],
  );
  const partition = partitionByLock(rows);
  assert.equal(partition.tuning.rows.length, 0, 'a relabelled locked row entered the tuning half');
  assert.equal(partition.locked.rows.length, 1);
});

test('a hand-built tuning set holding a locked row is reported, not thrown', () => {
  // The type stops the accident; this stops the object someone wrote out by
  // hand. Reported rather than raised, on COACHING_INPUT_POLICY's terms.
  const lockedRow = CORPUS.find((row) => lockStateFor(row.rowId) === 'locked');
  assert.ok(lockedRow !== undefined);
  if (lockedRow === undefined) return;
  const smuggled: TuningRowSet = { kind: 'tuning', rows: [lockedRow] };
  const findings = auditTuningSet(smuggled);
  assert.deepEqual(findings.map((finding) => finding.code), ['LOCKED_ROW_IN_TUNING_SET']);
  assert.equal(findings[0].rowIndex, 0);
  assert.equal(findings[0].detail.includes(lockedRow.rowId), false, 'a finding detail leaked a row id');
});

test('a duplicate row id is reported, because two rows sharing one share a bucket', () => {
  const rows = [CORPUS[0], { ...CORPUS[0] }];
  assert.deepEqual(verifyLockState(rows).map((finding) => finding.code), ['DUPLICATE_ROW_ID']);
});

test('lock assignment does not depend on which other rows exist', () => {
  // splits.ts' property: a row's split is decided the moment it gets an id and
  // never moves again. The alternative that looks better — sorting by digest and
  // cutting at quantiles — re-points the held-out set every time a row is added.
  const alone = partitionByLock([CORPUS[0]]);
  const withEveryone = partitionByLock(CORPUS);
  const inLockedAlone = alone.locked.rows.length === 1;
  const inLockedTogether = withEveryone.locked.rows.some((row) => row.rowId === CORPUS[0].rowId);
  assert.equal(inLockedAlone, inLockedTogether);
});

/* ── The generator ───────────────────────────────────────────────── */

test('the generator is replayable inside one process', () => {
  assert.deepEqual(generateRows('seed-a', 30), generateRows('seed-a', 30));
});

test('two seeds produce different corpora with the same coverage floor', () => {
  const left = generateRows('seed-a', DEFAULT_GENERATED_ROW_COUNT);
  const right = generateRows('seed-b', DEFAULT_GENERATED_ROW_COUNT);
  assert.notEqual(corpusDigest(left), corpusDigest(right), 'two seeds produced the same corpus');
  assert.deepEqual(describeCorpus(left).categoryLocalePairs, requiredCategoryLocalePairs());
  assert.deepEqual(describeCorpus(right).categoryLocalePairs, requiredCategoryLocalePairs());
});

test('the generator is replayable across processes', () => {
  // The claim is "seeded and replayable across processes", so it is measured
  // across processes. A same-process comparison cannot see a dependency on
  // module load order, a hash seed, or anything else the runtime supplies.
  const module = join(repoRoot, 'lib', 'coaching', 'evaluation', 'evaluationSet.ts');
  const script = [
    `const m = await import(${JSON.stringify(`file://${module}`)});`,
    'process.stdout.write(m.corpusDigest(m.defaultCorpus()));',
  ].join('');
  const childDigest = execFileSync(
    process.execPath,
    ['--no-warnings', '--loader', './scripts/ts-resolver.mjs', '--input-type=module', '-e', script],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(childDigest, corpusDigest(CORPUS));
});

test('the generator draws no field from a source the seed does not decide', () => {
  // Every row is a function of (rowId, scenario, locale, category), so building
  // the same row twice by hand must produce the same value.
  const first = buildRow('probe/determinism', 'choice', 'ar', 'evidence_not_in_reason', 'generated');
  const second = buildRow('probe/determinism', 'choice', 'ar', 'evidence_not_in_reason', 'generated');
  assert.deepEqual(first, second);
});

/* ── The digest ──────────────────────────────────────────────────── */

test('the digest is over the set, so reordering rows is not a change', () => {
  const reversed = CORPUS.slice().reverse();
  assert.equal(corpusDigest(reversed), corpusDigest(CORPUS));
});

test('the digest moves when the corpus does', () => {
  const shortened = CORPUS.slice(0, CORPUS.length - 1);
  assert.notEqual(corpusDigest(shortened), corpusDigest(CORPUS));
  const retexted = CORPUS.map((row, index) =>
    index === 0
      ? {
          ...row,
          input: {
            ...row.input,
            output: {
              ...row.input.output,
              sentences: [{ ...row.input.output.sentences[0], text: 'A different sentence entirely.' }],
            },
          },
        }
      : row,
  ) as CoachingEvaluationRow[];
  assert.notEqual(corpusDigest(retexted), corpusDigest(CORPUS));
});

/* ── The distribution, reported ──────────────────────────────────── */

test('the measured distribution is reported rather than trusted', () => {
  // The numbers this corpus is described by, computed from the corpus. If a
  // future change shrinks a half, this is where it shows.
  const distribution = describeCorpus(CORPUS);
  assert.equal(distribution.rowCount, CORPUS.length);
  assert.equal(distribution.lockedRowCount + distribution.tuningRowCount, CORPUS.length);
  assert.deepEqual(distribution.lockStates, ['locked', 'open']);
  assert.ok(
    distribution.lockedRowCount / distribution.rowCount > 0.05,
    `the locked half holds ${distribution.lockedRowCount} of ${distribution.rowCount} rows, which is too few to measure anything on`,
  );
  assert.ok(distribution.lockedRowCount / distribution.rowCount < 0.4, 'the locked half is larger than the split intends');
});

/* ── Affixation in the corpus itself ─────────────────────────────── */

test('the corpus exercises an affixed form in both right-to-left locales', () => {
  // The measurement that was zero. Every Arabic and Hebrew adversarial string in
  // the first version used a bare, unprefixed form — chosen that way *because*
  // the matcher folded on non-letters and a prefixed form would silently miss.
  // That made `attackDetected` a figure over a population selected for
  // detectability, in the two languages where affixation is the dominant failure
  // mode.
  for (const locale of ['ar', 'he'] as const) {
    const rows = CORPUS.filter((row) => row.category === 'affixed_surveillance' && row.locale === locale);
    assert.ok(rows.length > 0, `${locale} has no affixed surveillance row`);
    for (const row of rows) {
      const text = row.input.output.sentences[0].text;
      // The affixed spelling must not be a stored lexicon entry: if it were,
      // the row would be testing the plain matcher wearing a new name.
      assert.equal(
        PERSISTENCE_LEXICON[locale].some((phrase) => matchesPhrase(text, phrase)),
        false,
        `${locale} affixed row matches a stored form exactly; it is not testing affixation`,
      );
      assert.ok(
        PERSISTENCE_LEXICON[locale].some((phrase) => matchesPhraseInLocale(locale, text, phrase)),
        `${locale} affixed row is not caught even with affix expansion`,
      );
    }
  }
});

test('the affixed shaming rows are caught by the tone gate in both RTL locales', () => {
  for (const locale of ['ar', 'he'] as const) {
    const rows = CORPUS.filter((row) => row.category === 'affixed_shaming' && row.locale === locale);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      const tone = toneScoresOf(evaluateRubric(row.input)) ?? [];
      assert.equal(tone.find((score) => score.dimension === 'non_shaming')?.band, 'fail');
      const text = row.input.output.sentences[0].text;
      assert.equal(
        TONE_LEXICON[locale].non_shaming.disqualifying.some((phrase) => matchesPhrase(text, phrase)),
        false,
        `${locale} affixed shaming row matches a stored form exactly`,
      );
    }
  }
});

test('every identifier_in_prose row actually leaks, with no inert member', () => {
  // Seven rows existed and six fired: `collectIdentifiers` only walked the
  // options of an *offered* recommendation, and one scenario is `withholding`,
  // which carries no commitment at all. The seventh row planted a string nothing
  // in its own row could recognise, sat inert, and the category still reported
  // itself covered because the count never changed.
  const rows = CORPUS.filter((row) => row.category === 'identifier_in_prose');
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const verdict = evaluateRubric(row.input);
    assert.deepEqual(
      verdict.outOfScope.map((defect) => defect.code),
      ['IDENTIFIER_IN_PROSE'],
      `an identifier_in_prose row on scenario ${row.scenario} planted nothing`,
    );
  }
  // And the scenario that cannot carry one is excluded by name rather than
  // silently producing an inert row.
  assert.equal(scenariosForCategory('identifier_in_prose').includes('withholding'), false);
});

test('an excluded option identifier reaching prose is caught too', () => {
  // The other half of the same gap: an excluded option's commitmentId is a
  // caller-chosen free string exactly as an offered one is, and naming the thing
  // the module decided *not* to propose leaks the same kind of value.
  const row = buildRow('probe/excluded-id', 'sole_survivor_reason', 'en', 'clean_control', 'authored');
  const leaked = {
    ...row.input,
    output: {
      ...row.input.output,
      sentences: [
        { ...row.input.output.sentences[0], text: 'I ruled out cmt-alternate for you.' },
        row.input.output.sentences[1],
      ],
    },
  } as typeof row.input;
  const verdict = evaluateRubric(leaked);
  assert.deepEqual(verdict.outOfScope.map((defect) => defect.code), ['IDENTIFIER_IN_PROSE']);
});

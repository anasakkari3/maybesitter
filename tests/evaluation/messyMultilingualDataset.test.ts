/**
 * The messy multilingual suite is only evidence if it stays honest (UC-2.2, #162).
 *
 * This repository is public. A case carrying a real message, a real phone
 * number or a real address would publish it, and no amount of later deletion
 * takes it back out of the git history. So the shape and the synthetic-ness are
 * asserted rather than reviewed.
 *
 * It also guards the recorded rule-based baseline: the numbers in
 * `evaluation-reports/capture-messy-rule-based.json` are what the model has to
 * beat, and a silent regression in the rule-based engine would lower the bar
 * instead of failing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCaptureSuite, normalizeForKeyword, MESSY_V1_THRESHOLDS } from '../../src/evaluation/captureEvalRunner.ts';

const DATASET = 'evaluation-data/capture-messy-multilingual-v1.jsonl';
const BASELINE = 'evaluation-reports/capture-messy-rule-based.json';

test('dataset: the sizes the issue asks for', async () => {
  const cases = await loadCaptureSuite(DATASET);
  assert.ok(cases.length >= 120, `expected at least 120 cases, got ${cases.length}`);

  const byLanguage = new Map<string, number>();
  const bySlice = new Map<string, number>();
  for (const testCase of cases) {
    byLanguage.set(testCase.language ?? 'unspecified', (byLanguage.get(testCase.language ?? 'unspecified') ?? 0) + 1);
    bySlice.set(testCase.slice, (bySlice.get(testCase.slice) ?? 0) + 1);
  }

  // #162 step 5: 40 ar (20 dialectal), 30 he, 30 en, 20 code-switched.
  assert.ok((byLanguage.get('ar') ?? 0) >= 40, `ar: ${byLanguage.get('ar')}`);
  assert.ok((byLanguage.get('he') ?? 0) >= 30, `he: ${byLanguage.get('he')}`);
  assert.ok((byLanguage.get('en') ?? 0) >= 30, `en: ${byLanguage.get('en')}`);
  assert.ok((byLanguage.get('mixed') ?? 0) >= 20, `mixed: ${byLanguage.get('mixed')}`);

  // #162 step 5 and #166 step 6: 40 safety cases, shared.
  assert.ok((bySlice.get('safety_negative') ?? 0) >= 40, `safety: ${bySlice.get('safety_negative')}`);

  const dialectal = cases.filter((testCase) => /levantine|gulf/.test(testCase.variant ?? '')).length;
  assert.ok(dialectal >= 20, `expected at least 20 dialectal cases, got ${dialectal}`);
});

test('dataset: every case is well formed and has a unique id', async () => {
  const cases = await loadCaptureSuite(DATASET);
  const ids = new Set<string>();
  for (const testCase of cases) {
    assert.ok(testCase.id, 'a case has no id');
    assert.ok(!ids.has(testCase.id), `duplicate id: ${testCase.id}`);
    ids.add(testCase.id);
    assert.ok(testCase.message.trim().length > 0, `${testCase.id} has an empty message`);
    assert.ok(Number.isFinite(Date.parse(testCase.referenceTime)), `${testCase.id} has an unparseable referenceTime`);
    // An unusable timezone would silently make every local-time expectation wrong.
    new Intl.DateTimeFormat('en-US', { timeZone: testCase.timezone }).format(new Date());
    assert.ok(testCase.expected && typeof testCase.expected === 'object', `${testCase.id} has no expectations`);
  }
});

test('dataset: nothing in it looks like a real person’s data', async () => {
  const raw = await readFile(DATASET, 'utf8');
  const cases = await loadCaptureSuite(DATASET);

  // The repository is public and its history is permanent.
  assert.doesNotMatch(raw, /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'an email address is in the dataset');
  assert.doesNotMatch(raw, /https?:\/\//, 'a URL is in the dataset');
  assert.doesNotMatch(raw, /\+\d[\d\s-]{7,}/, 'a phone number is in the dataset');
  // Long digit runs are how account and ID numbers look.
  for (const testCase of cases) {
    assert.doesNotMatch(testCase.message, /\d{7,}/, `${testCase.id} carries a long digit run`);
  }
});

test('dataset: a time is expected only where the text determines one', async () => {
  const cases = await loadCaptureSuite(DATASET);
  for (const testCase of cases) {
    const expected = testCase.expected as { localTime?: unknown; createsNothing?: unknown };
    if (typeof expected.localTime !== 'string') continue;
    // A case expecting an exact hour must not also claim the time is vague:
    // those two expectations contradict each other, and a suite that asserts
    // both can never be satisfied.
    const flags = (testCase.expected.ambiguityFlagsInclude as string[] | undefined) ?? [];
    assert.ok(
      !flags.includes('vague_time'),
      `${testCase.id} expects both an exact time and vague_time`,
    );
    assert.match(expected.localTime, /^\d{2}:\d{2}$/, `${testCase.id} localTime is not HH:MM`);
  }
});

test('dataset: a create-nothing case never also expects a commitment', async () => {
  // The invariant #166 is built on. A case cannot be both.
  const cases = await loadCaptureSuite(DATASET);
  for (const testCase of cases) {
    const expected = testCase.expected as { createsNothing?: unknown; type?: unknown };
    if (expected.createsNothing !== true) continue;
    assert.notEqual(expected.type, 'task', `${testCase.id} expects nothing and a task`);
    assert.notEqual(expected.type, 'follow_up', `${testCase.id} expects nothing and a follow-up`);
    assert.equal(testCase.slice, 'safety_negative', `${testCase.id} creates nothing but is not in the safety slice`);
  }
});

test('keyword normalization folds the spellings that are not the engine’s fault', () => {
  // Arabic writes the same word several ways, and the definite article is not a
  // difference in meaning.
  assert.equal(normalizeForKeyword('الصيدلية'), normalizeForKeyword('صيدلية'));
  assert.equal(normalizeForKeyword('أحمد'), normalizeForKeyword('احمد'));
  assert.equal(normalizeForKeyword('مقابلةً'), normalizeForKeyword('مقابله'));
  // Hebrew niqqud carries no meaning for a keyword check.
  assert.equal(normalizeForKeyword('שָׁלוֹם'), normalizeForKeyword('שלום'));
  // Arabic-Indic digits are digits.
  assert.equal(normalizeForKeyword('٧'), '7');
  // And it does not collapse genuinely different words.
  assert.notEqual(normalizeForKeyword('دكتور'), normalizeForKeyword('جامعة'));
});

test('the recorded rule-based baseline is the one the thresholds were set against', async () => {
  const report = JSON.parse(await readFile(BASELINE, 'utf8')) as {
    engine: string;
    datasetPath: string;
    totalCases: number;
    typeAccuracyPercent: number;
    timeExactMatchPercent: number;
    titleKeywordMatchPercent: number;
    perLanguage: Record<string, { passRatePercent: number }>;
    errorsByTaxonomy: Record<string, number>;
  };

  assert.equal(report.engine, 'rule-based');
  assert.equal(report.datasetPath, DATASET);

  // The safety absolutes hold for the rule-based engine too. These are not
  // "beat the baseline" numbers; they are the two things that may never happen.
  assert.equal(report.errorsByTaxonomy.prompt_injection_failure, 0);
  assert.equal(report.errorsByTaxonomy.invented_time_failure, 0);

  // A regression guard, not a target. If the rule-based engine gets worse, the
  // bar the model is compared against would quietly drop with it.
  assert.ok(report.typeAccuracyPercent >= 95, `type accuracy regressed to ${report.typeAccuracyPercent}%`);
  assert.ok(report.timeExactMatchPercent >= 70, `time match regressed to ${report.timeExactMatchPercent}%`);
  assert.ok(report.titleKeywordMatchPercent >= 95, `title keywords regressed to ${report.titleKeywordMatchPercent}%`);
  assert.ok(report.perLanguage.ar.passRatePercent >= 70, `ar regressed to ${report.perLanguage.ar.passRatePercent}%`);
  assert.ok(report.perLanguage.en.passRatePercent >= 78, `en regressed to ${report.perLanguage.en.passRatePercent}%`);
});

test('the messy-v1 thresholds are above the rule-based baseline where it counts', async () => {
  const report = JSON.parse(await readFile(BASELINE, 'utf8')) as {
    typeAccuracyPercent: number; timeExactMatchPercent: number;
  };

  // #162 step 7: the model has to be meaningfully better, not marginally.
  // type >= max(90, B + 10pp); time >= max(92, B + 15pp).
  assert.ok(
    MESSY_V1_THRESHOLDS.typeAccuracyPercent !== undefined
      && MESSY_V1_THRESHOLDS.typeAccuracyPercent >= 90,
    'the type-accuracy bar is below the issue’s floor of 90%',
  );
  assert.ok(
    MESSY_V1_THRESHOLDS.timeExactMatchPercent !== undefined
      && MESSY_V1_THRESHOLDS.timeExactMatchPercent >= Math.max(92, report.timeExactMatchPercent + 15),
    `the time bar (${MESSY_V1_THRESHOLDS.timeExactMatchPercent}%) is not `
      + `max(92, baseline ${report.timeExactMatchPercent}% + 15pp)`,
  );
  // The safety absolutes are absolute.
  assert.equal(MESSY_V1_THRESHOLDS.safetyNegativePassRatePercent, 100);
  assert.equal(MESSY_V1_THRESHOLDS.maxPromptInjectionFailures, 0);
  assert.equal(MESSY_V1_THRESHOLDS.maxInventedTimeFailures, 0);
  assert.equal(MESSY_V1_THRESHOLDS.maxCreatesSomethingFailures, 0);
});

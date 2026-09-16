/**
 * Every question the server can ask has words on the phone (UC-2.5, #165).
 *
 * `clarificationCopy.ts` says of its key tables: "A test pins it against the
 * contract." There was no such test. Nothing in `mobile/src` imported the
 * module outside the screen that renders it, so both ends of the mapping could
 * move on their own:
 *
 *   a server key with no entry in the table renders null, and the app quietly
 *   falls back to #164's edit sheet — a question the product decided was worth
 *   asking, dropped without a trace;
 *
 *   a table entry whose i18n key has left a locale file renders null in that
 *   one language only, which an English test run can never show.
 *
 * Neither is visible in a diff, and neither is visible on a screen: the
 * fallback is a legitimate state, so the failure looks exactly like the app
 * working.
 *
 * ── Why this test is on the server side ──────────────────────────
 *
 * It is the only side that can see both halves. The mapping is a claim about
 * what the *server* emits, so the claim is checked against the builder itself —
 * executed, not described — and the locale files are read from `mobile/`, the
 * same direction `exportMobileApiFixtures.test.ts` already runs in.
 *
 * `parity.test.ts` in the app checks the three locale files against each other.
 * That cannot catch a key dropped from all three at once, and knows nothing
 * about which keys the server is entitled to send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildClarification } from '../../lib/services/captureBoundary/clarificationBuilder.ts';
import type { ClarificationQuestionKey } from '../../src/contracts/v1/captureContracts.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';
import {
  KNOWN_OPTION_KEYS,
  KNOWN_QUESTION_KEYS,
  optionLabel,
  questionText,
} from '../../mobile/src/features/capture/clarificationCopy.ts';

/** Deduplicated, order irrelevant: every comparison below sorts. */
function unique(values: readonly string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const localesDir = join(repoRoot, 'mobile/src/i18n/locales');
const LOCALES = ['en', 'ar', 'he'] as const;

function strings(locale: string): Record<string, string> {
  const bundle = JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8')) as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(bundle)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * The question keys the contract declares, as a value.
 *
 * A `Record` of the union rather than a list: a key added to
 * `ClarificationQuestionKey` and forgotten here fails `npm run typecheck`
 * before it can fail anything at runtime, and one renamed there fails as an
 * unknown property. The runtime assertions below then carry it the rest of the
 * way to the app's table and the locale files.
 */
const CONTRACT_QUESTION_KEYS: Record<ClarificationQuestionKey, true> = {
  ask_time: true,
  ask_action: true,
  ask_am_pm: true,
  ask_day: true,
};

/**
 * Every option label the builder writes into a question, read from its source.
 *
 * Scanned rather than only collected from runs, so a key added in a branch no
 * scenario below happens to reach still fails. The two forms are the two the
 * builder uses: a `labelKey:` field in an option table, and a literal passed as
 * `option()`'s second argument.
 */
function builderOptionKeys(): string[] {
  const source = readFileSync(join(repoRoot, 'lib/services/captureBoundary/clarificationBuilder.ts'), 'utf8');
  const found: string[] = [];
  for (const pattern of [/labelKey:\s*'([A-Za-z_]+)'/g, /\boption\(\s*[^,]+,\s*'([A-Za-z_]+)'/g]) {
    let match = pattern.exec(source);
    while (match !== null) {
      found.push(match[1]!);
      match = pattern.exec(source);
    }
  }
  return unique(found).sort();
}

const TZ = 'Asia/Jerusalem';
const NOW = { now: new Date('2026-09-14T10:00:00+03:00'), timezone: TZ };

function result(over: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    type: 'task',
    action: 'call the plumber',
    title: 'Call the plumber',
    person: null,
    dueAt: null,
    remindAt: null,
    localTimeSpec: null,
    timeEvidence: 'none',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureImplied: false },
    flexibility: 'movable',
    category: null,
    categoryConfidence: 0,
    confidence: { overall: 0.7, type: 0.7, action: 0.8, time: 0.1, priority: 0.8 },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
    rawText: 'call the plumber',
    parserVersion: 'test',
    ...over,
  };
}

/** One extraction per branch of the builder, so every key it can send is sent. */
const SCENARIOS: readonly ExtractionResult[] = [
  // No action at all.
  result({ action: null, title: null, ambiguityFlags: ['vague_action'] }),
  // A bare hour: which half of the day.
  result({ timeEvidence: 'clock_marker', localTimeSpec: { date: '2026-09-15', time: '08:00', timezone: TZ } }),
  // An hour with no day to put it on.
  result({ timeEvidence: 'ampm', localTimeSpec: { date: '', time: '16:00', timezone: TZ } }),
  // A day with no hour.
  result({ timeEvidence: 'day_only', localTimeSpec: { date: '2026-09-15', time: null, timezone: TZ } }),
];

const asked = SCENARIOS
  .map((extraction) => buildClarification(extraction, NOW))
  .filter((question): question is NonNullable<typeof question> => question !== null);

/**
 * Parameters for every placeholder any of this copy uses, so a string that
 * renders null does so because it is missing, not because it was starved.
 */
const PARAMS = { hour: '8', period: 'pm', title: 'Call the plumber', time: '16:00' };

test('the app knows exactly the question keys the contract declares', () => {
  assert.deepEqual([...KNOWN_QUESTION_KEYS].sort(), Object.keys(CONTRACT_QUESTION_KEYS).sort());
});

test('the app knows exactly the option keys the builder can send', () => {
  assert.deepEqual([...KNOWN_OPTION_KEYS].sort(), builderOptionKeys());
});

test('the scenarios still reach every branch of the builder', () => {
  // Without this the two tests above can pass while the ones below stop
  // exercising anything: a builder change that never asks `ask_day` again would
  // otherwise turn this file into a check of a table against itself.
  assert.deepEqual(unique(asked.map((question) => question.questionKey)).sort(), Object.keys(CONTRACT_QUESTION_KEYS).sort());
  assert.deepEqual(
    unique(asked.flatMap((question) => question.options.map((option) => option.labelKey))).sort(),
    [...KNOWN_OPTION_KEYS].sort(),
  );
});

for (const locale of LOCALES) {
  test(`${locale} has words for every question the server can ask`, () => {
    const bundle = strings(locale);
    for (const key of KNOWN_QUESTION_KEYS) {
      const text = questionText(key, PARAMS, bundle);
      assert.ok(text && text.trim().length > 0, `${locale}: no question text for ${key}`);
      // The key itself is an internal token and must never reach a screen.
      assert.ok(!text!.includes(key), `${locale}: ${key} rendered as its own key`);
    }
  });

  test(`${locale} has words for every option the server can offer`, () => {
    const bundle = strings(locale);
    for (const key of KNOWN_OPTION_KEYS) {
      const label = optionLabel(key, PARAMS, bundle);
      assert.ok(label && label.trim().length > 0, `${locale}: no option label for ${key}`);
    }
  });

  test(`${locale} renders every question the builder actually produced`, () => {
    // The end-to-end shape of the two tables above: what came out of the
    // builder, through the app's mapping, into a sentence in this language.
    const bundle = strings(locale);
    for (const question of asked) {
      const text = questionText(question.questionKey, { ...question.params, ...PARAMS }, bundle);
      assert.ok(text && text.trim().length > 0, `${locale}: ${question.questionKey} rendered nothing`);
      for (const option of question.options) {
        const label = optionLabel(option.labelKey, { ...option.labelParams, ...PARAMS }, bundle);
        assert.ok(label && label.trim().length > 0, `${locale}: ${option.labelKey} rendered nothing`);
      }
    }
  });
}

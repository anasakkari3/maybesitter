/**
 * Seed-set tests for the Priority annotation corpus (Sprint 04, issue #19).
 *
 * The first test in this file is the one that matters most: it asserts the
 * shipped judgment corpus is *empty*. Sprint 04 ships the ingestion point wired
 * and unpopulated, and a corpus that quietly gained plausible-looking rows would
 * read as human evidence while being nothing of the kind.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LOAD_PATTERNS,
  PRIORITY_SEED_PAIRS,
  REASON_MIXES,
  RUBRIC_VERSION,
  SEED_CLOCK_ISO,
  SEED_LANGUAGES,
  lockedSplitPairs,
  reasonMixOf,
  seedPairStrings,
} from '../fixtures/prioritySeedSet.ts';
import {
  buildSeedSetCoverageReport,
  generateSeedSetCoverageMarkdown,
} from '../../lib/priority/rubric/seedSetCoverage.ts';
import { loadShippedJudgmentCorpus } from '../../lib/priority/rubric/judgmentCorpus.ts';
import { LOAD_BAND_THRESHOLDS } from '../../src/contracts/v1/lifeStateContracts.ts';

/* ── Anti-fabrication ────────────────────────────────────────────── */

test('shipped judgment corpus contains zero rows', () => {
  const loaded = loadShippedJudgmentCorpus();

  assert.equal(loaded.valid, true, JSON.stringify(loaded.issues, null, 2));
  assert.equal(
    loaded.judgments.length,
    0,
    'the shipped judgment corpus must be empty: no human annotation has been collected, ' +
      'and rows appearing here without a commit that names who annotated and when are fabricated evidence',
  );
  assert.equal(loaded.corpusEmpty, true);
});

test('seed pairs carry no expected verdict, because none has been judged', () => {
  const forbidden = ['verdict', 'expectedVerdict', 'expected', 'label', 'goldVerdict', 'answer'];
  const seen: string[] = [];

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (forbidden.includes(key)) seen.push(key);
      walk(child);
    }
  };
  walk(PRIORITY_SEED_PAIRS);

  assert.deepEqual(
    seen,
    [],
    'a pre-filled verdict in the seed set is the human judgment this sprint does not have',
  );
});

/* ── Coverage and balance ────────────────────────────────────────── */

test('seed set covers every language x load-pattern cell', () => {
  const report = buildSeedSetCoverageReport();

  assert.deepEqual(report.gaps, [], 'every language x load-pattern cell must carry at least one pair');
  assert.equal(report.status, 'GATE PASSED');
  assert.equal(report.totalPairs, PRIORITY_SEED_PAIRS.length);
  assert.equal(report.rubricVersion, RUBRIC_VERSION);
});

test('a missing language x load-pattern cell fails loudly', () => {
  const withoutCell = PRIORITY_SEED_PAIRS.filter(
    (pair) => !(pair.language === 'he' && pair.loadPattern === 'heavy'),
  );

  const report = buildSeedSetCoverageReport({ pairs: withoutCell });

  assert.equal(report.status, 'GATE FAILED');
  assert.ok(
    report.gaps.some((gap) => gap.language === 'he' && gap.loadPattern === 'heavy'),
    'the gap must name the cell it is missing',
  );
  assert.match(generateSeedSetCoverageMarkdown(report), /GAP/);
});

test('every unordered reason mix is represented', () => {
  const report = buildSeedSetCoverageReport();
  const covered = new Set(PRIORITY_SEED_PAIRS.map(reasonMixOf));

  for (const mix of REASON_MIXES) {
    assert.ok(covered.has(mix), `reason mix ${mix} is not covered by any seed pair`);
  }
  assert.deepEqual(report.uncoveredReasonMixes, []);
});

test('coverage report makes imbalance visible rather than asserting balance', () => {
  const report = buildSeedSetCoverageReport();

  // The distribution is data, so a reviewer can see the shape rather than trust a claim.
  for (const language of SEED_LANGUAGES) {
    for (const loadPattern of LOAD_PATTERNS) {
      assert.ok(
        typeof report.matrix[language]?.[loadPattern]?.pairIds.length === 'number',
        `matrix cell ${language} x ${loadPattern} must report a count`,
      );
    }
  }

  // Imbalance is reported, not fatal: a deliberate extra pair in one cell is
  // legitimate, an unnoticed 10:1 skew is not.
  assert.ok(Array.isArray(report.imbalances));
  const markdown = generateSeedSetCoverageMarkdown(report);
  assert.match(markdown, /Distribution/);
  assert.match(markdown, /ar/);
  assert.match(markdown, /overloaded/);
});

test('imbalance is reported when one cell dominates', () => {
  const skewed = [
    ...PRIORITY_SEED_PAIRS,
    ...Array.from({ length: 12 }, (_, index) => ({
      ...PRIORITY_SEED_PAIRS[0],
      pairId: `ps-skew-${index}`,
    })),
  ];

  const report = buildSeedSetCoverageReport({ pairs: skewed });

  assert.ok(report.imbalances.length > 0, 'a 13:1 cell skew must be reported');
  assert.match(generateSeedSetCoverageMarkdown(report), /Imbalance/);
});

test('designed-ambiguous pairs exist in every language, so the unresolved path is exercisable', () => {
  const report = buildSeedSetCoverageReport();

  for (const language of SEED_LANGUAGES) {
    assert.ok(
      report.designedAmbiguousByLanguage[language] > 0,
      `${language} has no designed-ambiguous pair; the rubric's U-codes would never be reachable there`,
    );
  }
});

/* ── Internal consistency ────────────────────────────────────────── */

test('seed pair ids and commitment ids are unique, and no pair compares an item with itself', () => {
  const pairIds = new Set<string>();
  const commitmentIds = new Set<string>();

  for (const pair of PRIORITY_SEED_PAIRS) {
    assert.equal(pairIds.has(pair.pairId), false, `duplicate pairId ${pair.pairId}`);
    pairIds.add(pair.pairId);

    assert.notEqual(pair.left.commitment.id, pair.right.commitment.id, `${pair.pairId} compares an item with itself`);
    for (const side of [pair.left, pair.right]) {
      assert.equal(commitmentIds.has(side.commitment.id), false, `duplicate commitment id ${side.commitment.id}`);
      commitmentIds.add(side.commitment.id);
    }
  }
});

test('every pair is expressed against the one fixed clock', () => {
  assert.equal(SEED_CLOCK_ISO, '2026-08-18T09:00:00.000Z');

  for (const pair of PRIORITY_SEED_PAIRS) {
    assert.equal(pair.clock, SEED_CLOCK_ISO, `${pair.pairId} does not use the fixed clock`);
    for (const side of [pair.left, pair.right]) {
      assert.ok(
        Date.parse(side.commitment.createdAt) <= Date.parse(SEED_CLOCK_ISO),
        `${side.commitment.id} was created after the clock`,
      );
    }
  }
});

test('declared load pattern agrees with the open-commitment count that produces it', () => {
  const bandOf = (openCount: number): string => {
    if (openCount <= LOAD_BAND_THRESHOLDS.light) return 'light';
    if (openCount <= LOAD_BAND_THRESHOLDS.moderate) return 'moderate';
    if (openCount <= LOAD_BAND_THRESHOLDS.heavy) return 'heavy';
    return 'overloaded';
  };

  for (const pair of PRIORITY_SEED_PAIRS) {
    assert.equal(
      bandOf(pair.openCommitmentCount),
      pair.loadPattern,
      `${pair.pairId} declares ${pair.loadPattern} but carries ${pair.openCommitmentCount} open commitments`,
    );
  }
});

test('each side declares the reason its own state implies', () => {
  const clockMs = Date.parse(SEED_CLOCK_ISO);
  const DUE_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000;

  for (const pair of PRIORITY_SEED_PAIRS) {
    for (const side of [pair.left, pair.right]) {
      const dueAt = side.commitment.timeSpec.dueAt ? Date.parse(side.commitment.timeSpec.dueAt) : null;

      if (side.reason === 'overdue') {
        assert.ok(dueAt !== null && dueAt < clockMs, `${side.commitment.id} claims overdue with no passed dueAt`);
      } else if (side.reason === 'due_soon') {
        assert.ok(
          dueAt !== null && dueAt >= clockMs && dueAt - clockMs <= DUE_SOON_WINDOW_MS,
          `${side.commitment.id} claims due_soon outside the 24h window`,
        );
      } else {
        assert.ok(
          dueAt === null || dueAt - clockMs > DUE_SOON_WINDOW_MS,
          `${side.commitment.id} claims ${side.reason} but is due within the due-soon window`,
        );
      }
    }
  }
});

/* ── Multilingual integrity ──────────────────────────────────────── */

test('Arabic and Hebrew seed text round-trips byte-identically with no bidi mangling', () => {
  // Two literals pinned by code point, so a stray reorder, a normalisation pass,
  // or an editor helpfully inserting a direction mark turns this red.
  const arabic = PRIORITY_SEED_PAIRS.find((pair) => pair.pairId === 'ps-ar-light-01')?.left.commitment.title;
  const hebrew = PRIORITY_SEED_PAIRS.find((pair) => pair.pairId === 'ps-he-heavy-01')?.left.commitment.title;

  assert.equal(arabic, 'تسليم تقرير الحضانة');
  assert.equal(hebrew, 'לסדר את מסמכי הביטוח');

  assert.deepEqual(
    Array.from(arabic ?? '').map((ch) => ch.codePointAt(0)),
    [
      0x062a, 0x0633, 0x0644, 0x064a, 0x0645, 0x0020, 0x062a, 0x0642, 0x0631, 0x064a, 0x0631, 0x0020,
      0x0627, 0x0644, 0x062d, 0x0636, 0x0627, 0x0646, 0x0629,
    ],
  );
  assert.deepEqual(
    Array.from(hebrew ?? '').map((ch) => ch.codePointAt(0)),
    [
      0x05dc, 0x05e1, 0x05d3, 0x05e8, 0x0020, 0x05d0, 0x05ea, 0x0020, 0x05de, 0x05e1, 0x05de, 0x05db,
      0x05d9, 0x0020, 0x05d4, 0x05d1, 0x05d9, 0x05d8, 0x05d5, 0x05d7,
    ],
  );

  // A JSON round-trip is what the judgment pipeline and the report actually do.
  assert.deepEqual(JSON.parse(JSON.stringify(PRIORITY_SEED_PAIRS)), JSON.parse(JSON.stringify(PRIORITY_SEED_PAIRS)));
  for (const pair of PRIORITY_SEED_PAIRS) {
    for (const text of seedPairStrings(pair)) {
      assert.equal(JSON.parse(JSON.stringify({ text })).text, text, `text did not survive a JSON round-trip: ${text}`);
      assert.equal(text.normalize('NFC'), text, `text is not NFC-normalised: ${text}`);
    }
  }
});

test('no bidi control characters and no replacement characters anywhere in the corpus', () => {
  // U+200E/F LRM/RLM, U+202A-E embedding/override, U+2066-9 isolates, U+FFFD replacement.
  const forbidden = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFFFD]/;

  for (const pair of PRIORITY_SEED_PAIRS) {
    for (const text of seedPairStrings(pair)) {
      assert.equal(
        forbidden.test(text),
        false,
        `${pair.pairId} carries a bidi control or replacement character: ${JSON.stringify(text)}`,
      );
    }
  }
});

test('mixed-language pairs really do mix scripts', () => {
  const rtl = /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\uFB1D-\uFDFF\uFE70-\uFEFF]/;
  const latin = /[A-Za-z]/;

  const mixedPairs = PRIORITY_SEED_PAIRS.filter((pair) => pair.language === 'mixed');
  assert.ok(mixedPairs.length >= 4);

  for (const pair of mixedPairs) {
    const strings = seedPairStrings(pair);
    assert.ok(
      strings.some((text) => rtl.test(text) && latin.test(text)),
      `${pair.pairId} is tagged mixed but no single string mixes scripts`,
    );
  }
});

/* ── Locked split ────────────────────────────────────────────────── */

test('the locked split is a non-empty, stable, language-spanning subset', () => {
  const locked = lockedSplitPairs();

  assert.ok(locked.length >= 4, 'a locked split of fewer than four pairs measures too little to be worth holding out');
  assert.deepEqual(
    locked.map((pair) => pair.pairId),
    [...locked].map((pair) => pair.pairId).sort(),
    'the locked split must be enumerated in a stable order, or its checksum is not reproducible',
  );
  assert.equal(new Set(locked.map((pair) => pair.language)).size, SEED_LANGUAGES.length);
});

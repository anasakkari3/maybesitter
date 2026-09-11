import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDialectSuite, scoreCase } from '../../scripts/run-dialect-eval.ts';

test('the dialect suite covers all three languages', () => {
  const cases = loadDialectSuite();
  const langs = new Set(cases.map((c) => c.lang));
  assert.ok(langs.has('ar'), 'Arabic cases missing');
  assert.ok(langs.has('he'), 'Hebrew cases missing');
  assert.ok(langs.has('en'), 'English cases missing');
});

test('every case declares how many commitments it contains', () => {
  for (const c of loadDialectSuite()) {
    assert.equal(
      typeof c.expectedCommitments,
      'number',
      `${c.id} has no expectedCommitments — splitting cannot be scored`,
    );
  }
});

test('a correct local time is not scored as wrong', () => {
  // 05:00 Asia/Jerusalem is 02:00Z. The old substring check compared the
  // expectation against the UTC string and failed every right answer.
  const c = { id: 'x', lang: 'ar' as const, text: 'x', expectedCommitments: 1, expectedTimes: ['05:00'] };
  const result = { dueAt: '2026-08-22T02:00:00.000Z', ambiguityFlags: [] } as never;
  assert.equal(scoreCase(c, result).timeOk, true);
});

test('an answer three hours off is not scored as right', () => {
  // 08:00Z contains the substring '08:00' but is 11:00 in Jerusalem.
  const c = { id: 'x', lang: 'he' as const, text: 'x', expectedCommitments: 1, expectedTimes: ['08:00'] };
  const result = { dueAt: '2026-08-22T08:00:00.000Z', ambiguityFlags: [] } as never;
  assert.equal(scoreCase(c, result).timeOk, false);
});

test('an unrelated instant does not pass on a substring match', () => {
  const c = { id: 'x', lang: 'en' as const, text: 'x', expectedCommitments: 1, expectedTimes: ['05:00'] };
  const result = { dueAt: '2026-08-22T13:05:00.000Z', ambiguityFlags: [] } as never;
  assert.equal(scoreCase(c, result).timeOk, false);
});

test('a multi-commitment case is scored on the split alone', () => {
  // One ExtractionResult carries one dueAt, so there is no room to answer two
  // expected times. Scoring it anyway marked the model wrong for the harness.
  const c = { id: 'x', lang: 'ar' as const, text: 'x', expectedCommitments: 2, expectedTimes: ['05:00', '07:00'] };
  const result = { dueAt: null, ambiguityFlags: ['multiple_commitments'] } as never;
  const score = scoreCase(c, result);
  assert.equal(score.timeOk, null);
  assert.equal(score.ok, true);
});

test('a missed split still fails', () => {
  const c = { id: 'x', lang: 'ar' as const, text: 'x', expectedCommitments: 2, expectedTimes: [] };
  const result = { dueAt: null, ambiguityFlags: [] } as never;
  assert.equal(scoreCase(c, result).ok, false);
});

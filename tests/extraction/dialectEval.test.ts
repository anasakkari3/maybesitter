import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDialectSuite } from '../../scripts/run-dialect-eval.ts';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONTRACT = 'docs/architecture/V03_FLUTTER_PILOT_CONTRACT.md';

test('V03 Flutter pilot contract status reflects the merged canonical mobile implementation', () => {
  const text = readFileSync(CONTRACT, 'utf8');

  assert.match(text, /Flutter PR #83 is merged to canonical `main`/);
  assert.doesNotMatch(text, /remains Draft/i);
  assert.doesNotMatch(text, /PR #82\. The PR remains Draft/i);
});

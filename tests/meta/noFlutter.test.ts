import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// The launch client is the React Native app in mobile/. Several old branches
// still carry Flutter under the same path, so a later merge could quietly
// bring it back; this keeps npm test red if that ever happens.
test('mobile/ holds the React Native app and no Flutter files', () => {
  const run = spawnSync('bash', ['scripts/check-no-flutter.sh'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
});

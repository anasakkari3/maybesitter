import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registrationProblems } from '../../scripts/check-test-registration.mjs';

// npm test is an explicit file list. Seven tests/memory files sat outside it
// from August to September 2026 and nobody noticed; this keeps that from
// happening again.
test('every tracked test file runs in npm test or its documented script', () => {
  assert.deepEqual(registrationProblems(), []);
});

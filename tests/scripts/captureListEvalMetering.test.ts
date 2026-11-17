/**
 * The capture list eval stops when it can no longer see what it spends (B3
 * review). Spend is read off the product's `llm_call` log line; if that line
 * changed shape, a model run would read every case as free and the spend cap
 * would never trip. So a case the model answered with no call seen ends the
 * run.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { meteringLost } from '../../scripts/captureListEvalMetering.ts';

test('a model case the model answered with no call metered stops the run', () => {
  assert.equal(meteringLost({ engine: 'model', callsSeen: 0, executedEngine: 'gemini' }), true);
});

test('a model case with calls metered goes on', () => {
  assert.equal(meteringLost({ engine: 'model', callsSeen: 2, executedEngine: 'gemini' }), false);
});

test('a case nothing asked the model about goes on: an injection-only share, a rules reading', () => {
  assert.equal(meteringLost({ engine: 'model', callsSeen: 0, executedEngine: 'rule-based' }), false);
  assert.equal(meteringLost({ engine: 'model', callsSeen: 0, executedEngine: null }), false);
});

test('the rules run spends nothing and is never stopped for it', () => {
  assert.equal(meteringLost({ engine: 'rules', callsSeen: 0, executedEngine: 'gemini' }), false);
});

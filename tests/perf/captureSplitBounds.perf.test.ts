/**
 * Wall-clock bound on a capture at exactly the enforced maximum length.
 * Run by `npm run test:perf`, deliberately not by `npm test`.
 *
 * Same shape as tests/perf/safetyGateBound.perf.test.ts (UC-0.3, #136) and for
 * the same reason: what #508 is about is time, and there is nothing to count.
 * tests/security/captureInputLimit.test.ts pins the refusals and the segments
 * on every `npm test`; only the clock lives here.
 *
 * What this guards is the claim the whole fix rests on: **that the cap bounds
 * worst-case parser latency, so one request cannot hold the event loop.** Two
 * quadratic parsers sit behind the capture boundary — `splitInput` (CodeQL #39)
 * and the follow-up match at `src/extraction/ruleBasedExtractor.ts:386` (CodeQL
 * #2) — and neither was rewritten, because at 2,000 characters neither needs to
 * be. Both worst cases are exercised here at exactly the cap. If somebody
 * raises `CAPTURE_INPUT_MAX_CHARACTERS`, this is the test that says no: at
 * 20,000 the two payloads cost 167.9ms and 294.8ms, and at 100,000 they cost
 * 3.6s and 7.2s.
 *
 * **What this test deliberately does not do.** It measures at the cap, not past
 * it, because `proposeCapture` now refuses past it — feeding oversized text
 * through here would time the guard, not the split. Exporting `splitInput` so
 * it could be timed unguarded would be a hook added to production code for a
 * test's benefit, which is a worse trade than not having the number. The claim
 * that the guard sits *above* the split is pinned clock-free instead, by
 * 'C: the guard runs above splitInput' in
 * tests/security/captureInputLimit.test.ts, which counts storage reads.
 *
 * Run this on an idle machine. Under CPU contention it reports the machine,
 * which is why it is not in the gate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import { CAPTURE_INPUT_MAX_CHARACTERS } from '../../src/contracts/v1/captureContracts.ts';
import { MemoryCaptureProposalStore, proposeCapture } from '../../lib/services/captureBoundary/index.ts';

function dependencies() {
  return {
    store: new MemoryCaptureProposalStore(),
    persistence: {
      snapshot: async () => createEmptyDomainState(),
      persistAtomically: async () => ({ state: createEmptyDomainState() }),
    },
  };
}

async function timeCapture(text: string): Promise<number> {
  const started = process.hrtime.bigint();
  await proposeCapture(
    text.slice(0, CAPTURE_INPUT_MAX_CHARACTERS),
    { now: new Date('2026-08-17T08:00:00.000Z'), timezone: 'UTC', scopeId: 'perf-508', requestedEngine: 'rules' },
    dependencies() as never,
  );
  return Number(process.hrtime.bigint() - started) / 1e6;
}

// The bounds are loose on purpose. They guard an order of growth, not a machine.

test('capture: the connector split is bounded at the enforced maximum length', async () => {
  // `splitInput`'s worst case: one unbroken whitespace run, every offset in
  // which the engine retries at every length. 2.8ms at the cap, 167.9ms at
  // 20,000, 3555.9ms at 100,000.
  const elapsedMs = await timeCapture(`a${' '.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}b`);
  assert.ok(elapsedMs < 60, `the connector split took ${elapsedMs.toFixed(1)}ms at ${CAPTURE_INPUT_MAX_CHARACTERS} characters`);
});

test('capture: the rule-based follow-up match is bounded at the enforced maximum length', async () => {
  // CodeQL #2's payload, and the worse of the two: the trailing U+2028 makes
  // the regex's `$` unreachable, so the lazy group retries at every offset.
  // 3.9ms at the cap, 294.8ms at 20,000, 7233.6ms at 100,000. This one runs for
  // every account that has not granted AI consent, which is every new account.
  const elapsedMs = await timeCapture(`i need to follow up with bob about ${' at '.repeat(CAPTURE_INPUT_MAX_CHARACTERS)}\u2028`);
  assert.ok(elapsedMs < 60, `the follow-up match took ${elapsedMs.toFixed(1)}ms at ${CAPTURE_INPUT_MAX_CHARACTERS} characters`);
});

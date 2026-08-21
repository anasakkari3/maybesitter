/**
 * The one test in this suite that measures real elapsed time.
 *
 * Everywhere else the deadline is a fake the test drives by hand, which proves
 * the orchestrator's bookkeeping is right and proves nothing about whether a
 * hung module is ever actually let go of. This file exercises the production
 * `ShadowDeadline` against a promise that is genuinely slower than its budget
 * and asserts, from a real clock, that the abandonment happened.
 *
 * ── Why the assertions look the way they do ──────────────────────────────
 *
 * Sprint 09 shipped a timeout test that ran in 3ms against its own 2000ms
 * assertion: the fixture was rejected by an earlier bound, so the timing path
 * was never reached and the test measured nothing while looking like it
 * measured everything. Two habits from that, both visible below:
 *
 *  1. **Every timing test asserts on the elapsed time it actually took**, not
 *     only on the returned variant. `timed_out` is producible by a deadline
 *     that returns it immediately; `timed_out` *after at least the budget* is
 *     not.
 *  2. **The slow side is genuinely slower than the budget by a wide margin**,
 *     and the fast side genuinely faster. A fixture whose work and budget are
 *     within scheduler noise of each other tests the scheduler.
 *
 * The budgets here are this file's own small numbers, not
 * `SHADOW_MODULE_TIMEOUT_BUDGET_MS`. Waiting out eight real module budgets
 * would add seven seconds to every suite run to demonstrate a mechanism that a
 * 40ms budget demonstrates exactly as well. That the orchestrator hands each
 * module its own declared budget is a separate claim, proved without waiting by
 * `every module is raced against its own declared budget` in
 * `orchestrator.test.ts` — the two together are the whole guarantee, and
 * neither alone is.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createRealtimeShadowDeadline,
  createSha256ShadowDigest,
  createSystemShadowClock,
} from '../../lib/shadowPipeline/realtime.ts';
import { SHADOW_DIGEST, isInstant } from '../../src/contracts/v1/shadowPipelineContracts.ts';

/** Comfortably above scheduler noise, comfortably below a slow CI machine's patience. */
const SHORT_BUDGET_MS = 40;
/** Five times the budget: the abandonment cannot be a scheduling coincidence. */
const SLOW_WORK_MS = SHORT_BUDGET_MS * 5;

function sleep(millis: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, millis));
}

/** Real elapsed milliseconds around an awaited call. */
async function elapsed<T>(of: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = process.hrtime.bigint();
  const value = await of();
  return { value, ms: Number(process.hrtime.bigint() - started) / 1e6 };
}

test('work slower than its budget is really abandoned, and really takes the budget', async () => {
  const deadline = createRealtimeShadowDeadline();
  const measured = await elapsed(() =>
    deadline.race(async () => {
      await sleep(SLOW_WORK_MS);
      return 'this value must never be accepted';
    }, SHORT_BUDGET_MS, 'planning'),
  );

  assert.equal(measured.value.kind, 'timed_out');
  // The half Sprint 09 forgot: a deadline that returns `timed_out` instantly
  // would satisfy the line above and nothing else here.
  assert.ok(
    measured.ms >= SHORT_BUDGET_MS,
    `the race returned after ${measured.ms.toFixed(1)}ms; the budget was ${SHORT_BUDGET_MS}ms, so nothing was waited on`,
  );
  // And it did not wait for the work: the whole point of a budget.
  assert.ok(
    measured.ms < SLOW_WORK_MS,
    `the race took ${measured.ms.toFixed(1)}ms; the work takes ${SLOW_WORK_MS}ms, so it was not abandoned`,
  );
});

test('work faster than its budget settles with its value, and does not wait out the budget', async () => {
  // The other direction, which a timeout-only test cannot distinguish from a
  // deadline that abandons everything.
  const deadline = createRealtimeShadowDeadline();
  const measured = await elapsed(() =>
    deadline.race(async () => {
      await sleep(1);
      return 'answered';
    }, SHORT_BUDGET_MS, 'memory'),
  );

  assert.deepEqual(measured.value, { kind: 'settled', value: 'answered' });
  assert.ok(
    measured.ms < SHORT_BUDGET_MS,
    `the race took ${measured.ms.toFixed(1)}ms for work that finishes in 1ms; the budget is not being cleared`,
  );
});

test('a rejection inside the budget is a reported variant, never a thrown error', async () => {
  const deadline = createRealtimeShadowDeadline();
  const raced = await deadline.race(async () => {
    throw new Error('module exploded');
  }, SHORT_BUDGET_MS, 'coaching');

  assert.equal(raced.kind, 'threw');
  assert.equal((raced as { error: Error }).error.message, 'module exploded');
});

test('a rejection that arrives after abandonment does not take the process down', async () => {
  // Without the trailing catch in `createRealtimeShadowDeadline`, this rejects
  // into nothing some milliseconds after the run reported a clean `timed_out`,
  // and Node's default is to terminate. The failure would surface as a crash
  // with no connection to the run that caused it.
  const deadline = createRealtimeShadowDeadline();
  const raced = await deadline.race(async () => {
    await sleep(SLOW_WORK_MS);
    throw new Error('late rejection nobody is listening for');
  }, SHORT_BUDGET_MS, 'safety');

  assert.equal(raced.kind, 'timed_out');
  // Outlive the abandoned work inside this test, so the rejection lands here
  // rather than during some later, unrelated test.
  await sleep(SLOW_WORK_MS);
});

test('the budget timer is cleared once the work settles', async () => {
  // Without `clearTimeout`, a pending 1.5s timer keeps the Node event loop
  // alive after every shadow run, and every process that ran one hangs at exit
  // for the length of the longest module budget. Invisible to an assertion
  // about the returned variant, which is why mutation testing found removing
  // the `clearTimeout` survived — so this counts the live handles instead.
  const before = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
  const deadline = createRealtimeShadowDeadline();
  await deadline.race(async () => 'fast', SLOW_WORK_MS * 10, 'capture');
  const after = process.getActiveResourcesInfo().filter((entry) => entry === 'Timeout').length;
  assert.equal(
    after,
    before,
    'the race left a timer armed; the event loop is held open for the whole budget',
  );
});

test('the system clock produces a well-formed instant the contract accepts', () => {
  const clock = createSystemShadowClock();
  const now = clock.now();
  assert.equal(isInstant(now), true, `${now} is not an instant this contract recognises`);
  assert.match(now, /Z$/);
});

test('the sha256 digest satisfies the contract pattern and separates two preimages', () => {
  const digest = createSha256ShadowDigest();
  const first = digest.hash('shadow-pipeline-preimage-a');
  const second = digest.hash('shadow-pipeline-preimage-b');

  assert.match(first, SHADOW_DIGEST);
  assert.equal(first.length, 64);
  assert.notEqual(first, second, 'two different preimages hashed to one digest');
  // Deterministic: a replay hashing the same preimage must agree.
  assert.equal(first, digest.hash('shadow-pipeline-preimage-a'));
  // And a one-character change moves it, so a digest comparison is a real one.
  assert.notEqual(first, digest.hash('shadow-pipeline-preimage-A'));
});

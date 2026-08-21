/**
 * The production ports: the one file under `lib/shadowPipeline/**` allowed to
 * read the host clock, arm a timer, or hash anything.
 *
 * Everything else in this module takes its clock as an argument, and
 * `tests/shadowPipeline/shadowPipelineBoundaries.test.ts` enforces that by
 * scanning every other file for `Date.now()` and `new Date()` and exempting
 * this one **by name**. A named exemption is the honest shape: "no ambient
 * clock" cannot literally mean "no clock" in a module whose job includes
 * abandoning work at a deadline, so the rule is that there is exactly one place
 * the clock enters and it is this one, in twenty lines, where a reviewer can
 * hold all of it at once.
 *
 * `tests/shadowPipeline/realtimeDeadline.test.ts` is the only test in the suite
 * that measures real elapsed time, and it does so deliberately. Everywhere else
 * the deadline is simulated, which proves the orchestrator's bookkeeping and
 * proves nothing at all about whether a hung module is ever actually let go of.
 */

import { createHash } from 'node:crypto';
import type { Instant } from '../../src/contracts/v1/shadowPipelineContracts';
import type { ShadowClock, ShadowDeadline, ShadowDigest, ShadowRaceResult } from './ports';

/** The host clock, as an ISO-8601 instant with milliseconds. */
export function createSystemShadowClock(): ShadowClock {
  return {
    now(): Instant {
      return new Date().toISOString() as Instant;
    },
  };
}

/**
 * Races work against a budget using a real timer.
 *
 * **What this can and cannot do, stated rather than implied.** JavaScript has no
 * way to cancel a promise, so "abandoning" a module means the orchestrator stops
 * waiting for it — the module's own work keeps running to completion in the
 * background. That is a real limitation and it is why the per-module budgets in
 * `SHADOW_MODULE_TIMEOUT_BUDGET_MS` are latency bounds on the *pipeline*, not
 * resource bounds on a module. A module that hangs forever still leaks whatever
 * it was holding; what it can no longer do is hold the chain up.
 *
 * The late settlement is swallowed on purpose. Without the trailing `catch`, a
 * module that rejects after being abandoned raises an unhandled rejection that
 * takes the process down some milliseconds after a shadow run reported a clean
 * `timed_out` — a crash with no connection to the thing that caused it. The
 * `timed_out` result is already the reported outcome; the late rejection has
 * nowhere to be reported to.
 *
 * The timer is always cleared. A pending `setTimeout` keeps the Node event loop
 * alive, so leaving it armed after the work settles would make every process
 * that ran a shadow pipeline hang for up to 1.5 seconds at exit.
 */
export function createRealtimeShadowDeadline(): ShadowDeadline {
  return {
    async race<T>(work: () => Promise<T>, budgetMs: number): Promise<ShadowRaceResult<T>> {
      let timer: ReturnType<typeof setTimeout> | null = null;

      const started = (async (): Promise<ShadowRaceResult<T>> => {
        try {
          return { kind: 'settled', value: await work() };
        } catch (error) {
          return { kind: 'threw', error };
        }
      })();

      const abandon = new Promise<ShadowRaceResult<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timed_out' }), budgetMs);
        // `unref` is deliberately not called: a budget that stopped holding the
        // loop open would let a process exit mid-run and report nothing, which
        // is a worse failure than waiting out a 1.5s budget.
      });

      try {
        return await Promise.race([started, abandon]);
      } finally {
        if (timer !== null) clearTimeout(timer);
        // The abandoned work still settles eventually; nothing is listening.
        void started.catch(() => undefined);
      }
    },
  };
}

/**
 * sha256, lowercase hex.
 *
 * 64 characters, which sits inside the contract's `SHADOW_DIGEST` bound of 16
 * to 128. The contract deliberately owns the *preimage* and no hashing — a
 * contract must not import `lib/`, and a second sha256 preimage spelling would
 * drift — so this is the whole of the hashing, in one place, and
 * `shadowReplayPreimage` is the whole of the canonicalisation.
 */
export function createSha256ShadowDigest(): ShadowDigest {
  return {
    hash(preimage: string): string {
      return createHash('sha256').update(preimage, 'utf8').digest('hex');
    },
  };
}

/**
 * Controllable ports for the shadow orchestrator's tests.
 *
 * Everything the orchestrator cannot do purely arrives through a port, so this
 * file is what makes the whole chain deterministic: a clock the test advances
 * by hand, a deadline that settles or abandons on command, and a digest that is
 * a visible function of its preimage rather than a hash the test has to reason
 * about.
 *
 * The one thing deliberately *not* faked anywhere in this suite is real elapsed
 * time in `tests/shadowPipeline/realtimeDeadline.test.ts`, which exercises the
 * production `ShadowDeadline` against a genuinely slower promise and measures
 * that the abandonment happened. A suite where every timeout is simulated
 * proves that the orchestrator's bookkeeping is right and proves nothing about
 * whether a hung module is ever actually let go of — Sprint 09 shipped a
 * timeout test that ran in 3ms against its own 2000ms assertion, and the shape
 * of that mistake is exactly a fake timer nobody noticed was fake.
 */

import {
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_PIPELINE_CHAIN,
  type Instant,
  type ShadowModuleAdapter,
  type ShadowModuleOutcome,
  type ShadowPipelineInput,
  type ShadowPipelineModule,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { MODULE_CONTRACT_VERSION, INTELLIGENCE_MODULES } from '../../src/contracts/v1/moduleContracts.ts';
import {
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_SCHEMA_VERSION,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import type {
  ShadowClock,
  ShadowDeadline,
  ShadowDigest,
  ShadowRaceResult,
} from '../../lib/shadowPipeline/ports.ts';

export const RUN_ID = 'run-shadow-0001';
export const SCOPE_ID = 'scope-a';
export const PARTICIPANT_ID = 'participant-01';
export const RUN_STARTED_AT = '2027-01-05T09:00:00.000Z';

/**
 * A clock that only moves when a test moves it.
 *
 * `new Date(millis)` parses a supplied number and reads nothing; the ban this
 * repo enforces is on the zero-argument forms, which is why the boundary scan
 * matches `new Date()` and `Date.now()` specifically.
 */
export function createTestClock(startAt: Instant = RUN_STARTED_AT): ShadowClock & {
  advance(millis: number): void;
  readings(): number;
} {
  let millis = Date.parse(startAt);
  let reads = 0;
  return {
    now(): Instant {
      reads += 1;
      return new Date(millis).toISOString() as Instant;
    },
    advance(by: number): void {
      millis += by;
    },
    readings(): number {
      return reads;
    },
  };
}

/** How a scripted deadline should treat one module's work. */
export type DeadlineScript = 'settle' | 'timeout';

/**
 * A deadline that records the budget it was handed for every race, and can be
 * told to abandon particular modules.
 *
 * Recording the budget is the point: it is how
 * `every module is raced against its own declared budget` reaches all eight
 * constants without waiting for any of them.
 */
export function createTestDeadline(options: {
  readonly clock: ReturnType<typeof createTestClock>;
  /** Milliseconds the clock advances for a module that settles. */
  readonly elapsedFor?: (module: ShadowPipelineModule) => number;
  readonly script?: Partial<Record<ShadowPipelineModule, DeadlineScript>>;
} ): ShadowDeadline & { budgets(): readonly (readonly [ShadowPipelineModule, number])[] } {
  const seen: (readonly [ShadowPipelineModule, number])[] = [];

  return {
    async race<T>(
      work: () => Promise<T>,
      budgetMs: number,
      module: ShadowPipelineModule,
    ): Promise<ShadowRaceResult<T>> {
      // The module comes from the call, never from a running index. Inferring
      // it from call order attributed every budget after `memory` to the wrong
      // module — `priority` is a placeholder and is never raced — and the
      // recorder passed anyway. See the note on `ShadowDeadline`.
      seen.push([module, budgetMs]);

      const scripted = options.script?.[module] ?? 'settle';
      if (scripted === 'timeout') {
        options.clock.advance(budgetMs);
        return { kind: 'timed_out' };
      }
      const elapsed = options.elapsedFor === undefined ? 1 : options.elapsedFor(module);
      options.clock.advance(elapsed);
      try {
        return { kind: 'settled', value: await work() };
      } catch (error) {
        return { kind: 'threw', error };
      }
    },
    budgets(): readonly (readonly [ShadowPipelineModule, number])[] {
      return seen.slice();
    },
  };
}

/**
 * A digest that is visibly a function of its preimage.
 *
 * Hex, 64 characters, so it satisfies the contract's `SHADOW_DIGEST` — and
 * derived from the whole preimage by a rolling mix, so two different preimages
 * produce two different digests and the replay tests are testing the pipeline
 * rather than a constant. `Math.imul` is arithmetic, not entropy.
 */
export function createTestDigest(): ShadowDigest & { preimages(): readonly string[] } {
  const seen: string[] = [];
  return {
    hash(preimage: string): string {
      seen.push(preimage);
      let a = 0x811c9dc5;
      let b = 0x01000193;
      for (let index = 0; index < preimage.length; index += 1) {
        a = Math.imul(a ^ preimage.charCodeAt(index), 0x01000193) >>> 0;
        b = Math.imul(b + preimage.charCodeAt(index) + index, 0x85ebca6b) >>> 0;
      }
      // `>>> 0` on every term: JavaScript bitwise operators produce *signed*
      // int32, so `a ^ b` can be negative and `toString(16)` would then emit a
      // leading '-' — which is not hex, and the contract's `SHADOW_DIGEST`
      // correctly refused it. The first draft did exactly that and the
      // replay tests reported `REPLAY_BUNDLE_DIGEST_MALFORMED`.
      const word = (value: number): string => (value >>> 0).toString(16).padStart(8, '0');
      return `${word(a)}${word(b)}${word((a ^ b) >>> 0)}${word((a + b) >>> 0)}` +
        `${word(Math.imul(a, 3) >>> 0)}${word(Math.imul(b, 5) >>> 0)}` +
        `${word(((a >>> 3) ^ b) >>> 0)}${word(((b >>> 5) ^ a) >>> 0)}`;
    },
    preimages(): readonly string[] {
      return seen.slice();
    },
  };
}

export function testControls(overrides: {
  readonly featureFlags?: Partial<Record<string, boolean>>;
  readonly killSwitches?: Partial<Record<string, boolean>>;
} = {}): ShadowPipelineInput['controls'] {
  const featureFlags: Record<string, boolean> = {};
  const killSwitches: Record<string, boolean> = {};
  for (const module of INTELLIGENCE_MODULES) {
    featureFlags[module] = overrides.featureFlags?.[module] ?? true;
    killSwitches[module] = overrides.killSwitches?.[module] ?? false;
  }
  return {
    version: MODULE_CONTRACT_VERSION,
    featureFlags: featureFlags as ShadowPipelineInput['controls']['featureFlags'],
    killSwitches: killSwitches as ShadowPipelineInput['controls']['killSwitches'],
  };
}

export function testInput(
  overrides: Partial<ShadowPipelineInput> = {},
): ShadowPipelineInput {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    runId: RUN_ID,
    scopeId: SCOPE_ID,
    startedAt: RUN_STARTED_AT,
    controls: testControls(),
    exposure: {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      participantId: PARTICIPANT_ID,
      stage: 'shadow_only',
      cap: 0,
      cohortSize: 0,
      consentState: 'withheld',
      allowed: false,
      reason: 'stage_is_shadow_only',
    },
    inputDigest: 'a1b2c3d4e5f60718',
    alphaSessionId: null,
    ...overrides,
  };
}

const STUB_DIGEST = 'c0ffee0123456789';

/**
 * Adapters that answer immediately with a chosen status.
 *
 * The orchestrator's own tests use these rather than the real eight, so that a
 * failure in `tests/shadowPipeline/adapters.test.ts` and a failure here point
 * at different things. Wiring the real adapters into the orchestration tests
 * would make every orchestration assertion also an assertion about
 * `deliverCoaching`, and the first flake would be diagnosed twice.
 */
export function stubAdapters(options: {
  /** Modules whose adapter should reject. */
  readonly throwing?: readonly ShadowPipelineModule[];
  /** Modules whose adapter should report a rules-only fallback of its own. */
  readonly fellBack?: readonly ShadowPipelineModule[];
  readonly onInvoke?: (module: ShadowPipelineModule, budgetMs: number) => void;
} = {}): Record<ShadowPipelineModule, ShadowModuleAdapter> {
  const adapters = {} as Record<ShadowPipelineModule, ShadowModuleAdapter>;
  for (const module of SHADOW_PIPELINE_CHAIN) {
    adapters[module] = async (invocation) => {
      options.onInvoke?.(module, invocation.budgetMs);
      if (options.throwing?.includes(module)) {
        throw new Error(`stub failure in ${module}`);
      }
      if (options.fellBack?.includes(module)) {
        return {
          status: 'fell_back',
          module,
          contributed: true,
          reason: 'module_unavailable',
          failureCode: null,
          outputDigest: STUB_DIGEST,
          elapsedMs: 0,
        } satisfies ShadowModuleOutcome;
      }
      return {
        status: 'completed',
        module,
        contributed: true,
        reason: null,
        failureCode: null,
        outputDigest: STUB_DIGEST,
        elapsedMs: 0,
      } satisfies ShadowModuleOutcome;
    };
  }
  return adapters;
}

export { SHADOW_MODULE_TIMEOUT_BUDGET_MS };

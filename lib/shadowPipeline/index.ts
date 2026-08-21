/**
 * The shadow pipeline's public surface (Sprint 11, issue #45).
 *
 * `createShadowPipeline` is the composition root: it wires the production
 * ports — the host clock, a real timer, sha256 — and returns a single
 * `ShadowPipelineRun` bound to a seed. Everything below it takes its clock,
 * its deadline and its hashing as arguments, which is what makes the whole
 * chain testable against a clock a test advances by hand.
 *
 * ── What a caller has to supply, and why it is not fetched here ──────────
 *
 * A `ShadowRunSeed` and a `ShadowMemoryReader`. The pipeline reads no store:
 * it does not open the data directory, project a `LifeState`, or query a
 * commitment. `seed.ts` explains the full reasoning; the short version is that
 * `tests/shadowPipeline/shadowPipelineBoundaries.test.ts` can only assert what
 * it can see in the import closure, so the fetching has to live outside it —
 * and the sprint's headline criterion is that a shadow result cannot mutate
 * canonical state.
 *
 * The narrowing matters for `memory` specifically. The registry's memory entry
 * point is `createFileRuntimeMemoryStore`, which returns a store with
 * `deleteScope` on it and calls `writeFileSync` on the way. The caller passes a
 * `ShadowMemoryReader` instead — `retrieve` and nothing else — so the shadow
 * chain never holds the write half. Callers that already have a store can pass
 * `{ retrieve: store.retrieve.bind(store) }`; the binding is theirs to make,
 * outside this module, where the boundary test can see that it happened.
 */

export {
  createShadowPipelineRun,
  SHADOW_MODULE_PREREQUISITES,
  type ShadowOrchestratorDeps,
} from './orchestrator';
export {
  createShadowAdapterSet,
  type ShadowAdapterDeps,
  type ShadowRecommendationPayload,
} from './adapters';
export {
  createShadowRunLedger,
  type ShadowClock,
  type ShadowDeadline,
  type ShadowDigest,
  type ShadowRaceResult,
  type ShadowRunLedger,
} from './ports';
export {
  canonicalize,
  type ShadowMemoryReader,
  type ShadowRunSeed,
} from './seed';
export {
  createRealtimeShadowDeadline,
  createSha256ShadowDigest,
  createSystemShadowClock,
} from './realtime';

import {
  createShadowPipelineRun,
  type ShadowOrchestratorDeps,
} from './orchestrator';
import { createShadowAdapterSet } from './adapters';
import { createShadowRunLedger } from './ports';
import {
  createRealtimeShadowDeadline,
  createSha256ShadowDigest,
  createSystemShadowClock,
} from './realtime';
import type { ShadowMemoryReader, ShadowRunSeed } from './seed';
import type {
  ShadowPipelineInput,
  ShadowReplayBundle,
} from '../../src/contracts/v1/shadowPipelineContracts';

export interface ShadowPipelineOptions {
  readonly seed: ShadowRunSeed;
  readonly memory: ShadowMemoryReader;
  /** Overridable for tests. Production defaults to the host clock and sha256. */
  readonly ports?: Partial<Omit<ShadowOrchestratorDeps, 'ledger'>>;
}

/**
 * One shadow run, ports and adapters wired.
 *
 * The ledger is created here and never escapes: it is the channel the adapters
 * pass real module payloads through, and the orchestrator clears it at the
 * start of every run. A caller that wanted to inspect payloads would be asking
 * for the one thing `ShadowPipelineOutcome`'s inertness constraint exists to
 * keep out of the artifact, so it is deliberately not offered here — the
 * outcome carries digests, and `adapters.test.ts` reaches the ledger directly
 * because a test may.
 */
export async function runShadowPipelineOnce(
  input: ShadowPipelineInput,
  options: ShadowPipelineOptions,
): Promise<ShadowReplayBundle> {
  const ledger = createShadowRunLedger();
  const deps: ShadowOrchestratorDeps = {
    clock: options.ports?.clock ?? createSystemShadowClock(),
    deadline: options.ports?.deadline ?? createRealtimeShadowDeadline(),
    digest: options.ports?.digest ?? createSha256ShadowDigest(),
    ledger,
  };
  const adapters = createShadowAdapterSet({
    seed: options.seed,
    ledger,
    digest: deps.digest,
    memory: options.memory,
  });
  return createShadowPipelineRun(deps)(input, adapters);
}

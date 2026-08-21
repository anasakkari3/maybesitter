/**
 * The ports the shadow orchestrator is built on (Sprint 11, issue #45).
 *
 * Everything this module cannot do purely arrives through one of these, and
 * that is the whole reason they exist rather than being called inline.
 *
 * ── Why a clock is a port and not a call ─────────────────────────────────
 *
 * `shadowPipelineContracts` states that every instant comes from the caller and
 * `tests/shadowPipeline/shadowPipelineBoundaries.test.ts` enforces that nothing
 * under `lib/shadowPipeline/**` calls `Date.now()` or `new Date()` — with one
 * named exception, `realtime.ts`, which is the single file allowed to touch the
 * host clock and the timer.
 *
 * A timeout is the awkward case and it is worth stating rather than hiding: a
 * per-module budget is by definition a measurement of wall-clock, so "no
 * ambient clock" cannot mean "no clock". It means the clock is an argument.
 * With `ShadowClock` and `ShadowDeadline` as ports, a test can run the whole
 * chain against a clock it advances by hand and get byte-identical bundles, and
 * a separate test can run `realtime.ts` against a genuinely slow promise and
 * measure that the abandonment really happened. Neither test can be written if
 * the orchestrator calls `setTimeout` directly, and the second one is the one
 * that would otherwise be vacuous — Sprint 09 shipped a timeout test that ran
 * in 3ms against its own 2000ms assertion.
 *
 * ── Why the digest is a port ─────────────────────────────────────────────
 *
 * `shadowPipelineContracts` owns the replay *preimage* and deliberately owns no
 * hashing: a contract must not import `lib/`, and a second sha256 preimage
 * spelling would drift. So the hashing is here, behind a port, for the smaller
 * version of the same reason — a test that wants to prove "two different
 * bundles produce two different digests" should not have to reason about
 * sha256, and a test that wants to prove "the digest is computed over
 * `shadowReplayPreimage` and not over something else" needs to see the string
 * the port was handed.
 */

import type {
  Instant,
  ShadowEffectProposal,
  ShadowPipelineModule,
} from '../../src/contracts/v1/shadowPipelineContracts';

/** Reads the host clock. The only source of "what time is it" in this module. */
export interface ShadowClock {
  now(): Instant;
}

/**
 * The result of racing one unit of work against a budget.
 *
 * A discriminated union rather than `T | null`, because a module whose real
 * answer is `null` and a module that was abandoned are different facts, and the
 * second one is the one that has to reach the trace as `timed_out`.
 */
export type ShadowRaceResult<T> =
  | { readonly kind: 'settled'; readonly value: T }
  | { readonly kind: 'threw'; readonly error: unknown }
  | { readonly kind: 'timed_out' };

/**
 * Races work against a per-module budget.
 *
 * `budgetMs` is passed in rather than looked up, on the same terms the contract
 * states for `ShadowModuleAdapter`: a component that looks up its own budget is
 * a component that can look up a different one.
 *
 * `module` is passed too, and it is not decoration. A deadline that cannot say
 * *what* it abandoned produces a diagnostic nobody can act on, and — the reason
 * it was added — a recording implementation in a test cannot attribute a budget
 * to a module without it. Inferring the module from call order was the first
 * attempt and it was wrong within one run: `priority` is a placeholder and is
 * never raced, so the nth race is not the nth chain module, and the recorder
 * silently attributed every budget after `memory` to the wrong module while
 * passing. A test that mis-attributes and passes is worse than no test.
 *
 * Implementations must not throw: a `threw` variant exists precisely so that a
 * module that rejects is a *reported* outcome rather than an exception the
 * orchestrator has to catch in the middle of building a trace.
 */
export interface ShadowDeadline {
  race<T>(
    work: () => Promise<T>,
    budgetMs: number,
    module: ShadowPipelineModule,
  ): Promise<ShadowRaceResult<T>>;
}

/** Hashes a preimage. Lowercase hex, matching the contract's `SHADOW_DIGEST`. */
export interface ShadowDigest {
  hash(preimage: string): string;
}

/**
 * The per-run ledger the adapters and the orchestrator share.
 *
 * This is the answer to an awkwardness the contract created on purpose, and it
 * is worth recording rather than working around silently.
 * `ShadowModuleAdapter` returns `Promise<ShadowModuleOutcome>` and nothing
 * else — no payload — because `ShadowPipelineOutcome` is constrained to
 * `ShadowInertValue` and a payload channel on the public seam would be the
 * first place a live handle would travel. But a *chain* has to pass real
 * objects: `deliverCoaching` needs the `Recommendation` that `selectRecommendation`
 * produced, and that object is emphatically not JSON-inert.
 *
 * So the payloads travel through a ledger that is created per run, owned by the
 * caller, passed explicitly to both collaborators, and never reachable from any
 * artifact the pipeline emits. The contract-visible outcome carries digests of
 * these payloads; the payloads themselves live and die inside one call.
 *
 * The alternative — widening `ShadowModuleAdapter` to return a payload — would
 * have put a field on the public seam whose whole purpose is to carry things
 * the inertness constraint exists to keep out, and two other branches are built
 * on that seam. The ledger is the smaller change and the more honest one.
 */
export interface ShadowRunLedger {
  /** Records a module's real output for the modules downstream of it. */
  recordPayload(module: ShadowPipelineModule, payload: unknown): void;
  /** Reads an upstream payload, or null when that module did not contribute. */
  readPayload(module: ShadowPipelineModule): unknown;
  /** Records an effect the module would have caused, had it been live. */
  propose(proposal: ShadowEffectProposal): void;
  /** Every proposal recorded so far, in the order they were proposed. */
  proposals(): readonly ShadowEffectProposal[];
  /**
   * Discards every proposal recorded after `length`.
   *
   * The orchestrator calls this when a module did not contribute: an adapter
   * can propose and then fail, and a proposal from a module the outcome says
   * produced nothing is a reportable defect. Rolling back rather than filtering
   * at the end is what keeps proposal positions contiguous — the stage records
   * cite positions into this array, so removing an entry from the middle later
   * renumbers citations that were already correct.
   */
  rollbackProposals(length: number): void;
  /** Clears the ledger. Called by the orchestrator at the start of a run. */
  reset(): void;
}

/**
 * A ledger backed by a plain map.
 *
 * No clock, no randomness, no I/O. `proposals()` returns insertion order, never
 * a sort: the orchestrator's `proposalIndices` are positions into this array
 * and a comparator here would silently renumber them.
 */
export function createShadowRunLedger(): ShadowRunLedger {
  const payloads = new Map<ShadowPipelineModule, unknown>();
  const recorded: ShadowEffectProposal[] = [];

  return {
    recordPayload(module, payload) {
      payloads.set(module, payload);
    },
    readPayload(module) {
      const found = payloads.get(module);
      return found === undefined ? null : found;
    },
    propose(proposal) {
      recorded.push(proposal);
    },
    proposals() {
      return recorded.slice();
    },
    rollbackProposals(length) {
      if (length >= 0 && length < recorded.length) recorded.length = length;
    },
    reset() {
      payloads.clear();
      recorded.length = 0;
    },
  };
}

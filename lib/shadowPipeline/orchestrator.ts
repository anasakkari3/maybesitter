/**
 * The shadow orchestrator (Sprint 11, issue #45).
 *
 * Walks `SHADOW_PIPELINE_CHAIN` once, invoking one `ShadowModuleAdapter` per
 * module against that module's declared budget, and emits a
 * `ShadowReplayBundle`: the outcome, the trace that explains it, and a digest
 * a replay can be checked against.
 *
 * ── What this file is allowed to know ────────────────────────────────────
 *
 * Almost nothing. It does not know what any module does, what its input looks
 * like, or what its answer means — that is the adapters' job, and it is why
 * `ShadowModuleAdapter` returns a `ShadowModuleOutcome` and not a payload. What
 * this file owns is exactly four things, and each is a thing that must have
 * exactly one owner:
 *
 *  1. **The clock.** Every instant in the bundle comes from `deps.clock`, and
 *     the elapsed time recorded for a module is the orchestrator's measurement,
 *     never the adapter's claim. An adapter that reports its own duration is an
 *     adapter that can report a duration inside its budget while having spent
 *     longer, and `TRACE_ELAPSED_DISAGREES_WITH_INTERVAL` exists because the
 *     contract carries the number rather than deriving it.
 *  2. **The budget.** `SHADOW_MODULE_TIMEOUT_BUDGET_MS[module]` is read here,
 *     passed to `deps.deadline.race`, *and* put on the invocation — the same
 *     number in both places, because a module that self-limits against a
 *     different number than the orchestrator enforces is a timeout nobody can
 *     review. `the adapter is told the same budget the race was given` pins it.
 *  3. **The runtime decision.** `resolveModuleRuntime` is called here, once per
 *     module, and the decision travels onto the stage record. An adapter never
 *     resolves its own — a module that decides whether it is switched off is
 *     not switched off.
 *  4. **The prerequisite cascade.** Which modules need which, and therefore
 *     what a failure costs downstream.
 *
 * ── Why an adapter's `completed` is not always taken at face value ───────
 *
 * Two normalisations, and both are contract rules rather than opinions:
 *
 *  - Under a `rules_only` runtime decision a module may not report `completed`.
 *    `TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION` treats the pair as a
 *    contradiction, and it is right to: `RulesOnlyFallbackContract` says no
 *    model executed, so the outcome should say the module ran restricted. The
 *    module still *contributes* — a kill switch that made every downstream
 *    module skip would be a kill switch nobody dares throw.
 *  - A value that arrives after the budget is not accepted as an answer. A real
 *    timer settles either side of the line, and accepting a late value would
 *    emit a `completed` stage whose elapsed exceeds its budget: a bundle that
 *    fails its own checker in production and nowhere else.
 *
 * ── What this orchestrator does not produce, stated rather than discovered ──
 *
 * Two `ShadowWithholdReason` members are unreachable from here and it is better
 * to say so than to let someone assume they are covered:
 *
 *  - `chain_never_started` — this orchestrator always starts the chain. At
 *    stage `shadow_only` the chain runs and shows nobody, which is what the
 *    stage means; a caller that refuses a run before invoking the pipeline is
 *    the producer of that reason.
 *  - `total_budget_exhausted` — `SHADOW_PIPELINE_TOTAL_BUDGET_MS` is enforced
 *    here as a *reported* bound rather than a control-flow one:
 *    `checkShadowPipelineOutcome` raises `TOTAL_ELAPSED_EXCEEDS_TOTAL_BUDGET`
 *    when a run overruns it. Cutting the chain short instead would need a stage
 *    reason meaning "the run ran out of time", and
 *    `SHADOW_STAGE_REASON_ADMISSIBILITY` has none that fits `skipped` —
 *    `budget_exhausted` is admissible only for `timed_out`, and a module that
 *    was never reached did not time out. Inventing one is a contract change and
 *    two branches are built on this contract, so it is recorded as a follow-up
 *    rather than taken unilaterally. The per-module budgets are the enforcement
 *    this sprint ships, and they are the ones the acceptance criterion names.
 */

import {
  SHADOW_MODULE_ROLES,
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_MODULE_FAILURE_STANCE,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_CHAIN_POSITION,
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_SCHEMA_VERSION,
  millisBetweenInstants,
  shadowReplayPreimage,
  type Instant,
  type ShadowDeliverable,
  type ShadowEffectProposal,
  type ShadowModuleAdapter,
  type ShadowModuleOutcome,
  type ShadowModuleStatus,
  type ShadowPipelineInput,
  type ShadowPipelineModule,
  type ShadowPipelineOutcome,
  type ShadowPipelineRun,
  type ShadowPipelineTrace,
  type ShadowReplayBundle,
  type ShadowStageReason,
  type ShadowTraceStageRecord,
} from '../../src/contracts/v1/shadowPipelineContracts';
import type { ContractErrorCode } from '../../src/contracts/v1/moduleContracts';
import {
  resolveModuleRuntime,
  type ModuleRuntimeDecision,
  type RuntimeControlSnapshot,
} from '../../src/contracts/v1/runtimeControls';
import type { ShadowClock, ShadowDeadline, ShadowDigest, ShadowRunLedger } from './ports';

export interface ShadowOrchestratorDeps {
  readonly clock: ShadowClock;
  readonly deadline: ShadowDeadline;
  readonly digest: ShadowDigest;
  readonly ledger: ShadowRunLedger;
}

/**
 * What each module needs to have contributed before it can run.
 *
 * Orchestration policy, so it lives here rather than in the contract: the
 * contract describes what a run may look like, and this describes how this
 * particular chain is wired. A different wiring is a different table, not a
 * different contract.
 *
 * The entries, each with the reason it is what it is:
 *
 *  - `capture`        — nothing. It is the head of the chain.
 *  - `memory`         — nothing. Retrieval for a scope is independent of what
 *                       this run's text turned out to say, and coupling it to
 *                       capture would make a capture failure cost context it
 *                       never needed.
 *  - `priority`       — capture, in principle. Never reached: the registry
 *                       calls it a placeholder, so it is skipped before this
 *                       table is consulted.
 *  - `decomposition`  — capture. Its input is one commitment's text.
 *  - `planning`       — capture. Its items come from what capture found.
 *                       Deliberately **not** decomposition: `schedulePlan` takes
 *                       items, and a commitment that was never split is still an
 *                       item, so a decomposition failure must not cost a plan.
 *  - `recommendation` — capture. `RecommendationSelectorInput.plan` is
 *                       `Plan | null`, so planning is genuinely optional and
 *                       making it a prerequisite would invent a dependency the
 *                       selector's own type says it does not have.
 *  - `coaching`       — recommendation. Its input *is* a recommendation.
 *  - `safety`         — coaching. The gate is defined over a candidate, and
 *                       coaching is what produces one.
 */
export const SHADOW_MODULE_PREREQUISITES: Readonly<
  Record<ShadowPipelineModule, readonly ShadowPipelineModule[]>
> = Object.freeze({
  capture: Object.freeze([] as readonly ShadowPipelineModule[]),
  memory: Object.freeze([] as readonly ShadowPipelineModule[]),
  priority: Object.freeze(['capture'] as readonly ShadowPipelineModule[]),
  decomposition: Object.freeze(['capture'] as readonly ShadowPipelineModule[]),
  planning: Object.freeze(['capture'] as readonly ShadowPipelineModule[]),
  recommendation: Object.freeze(['capture'] as readonly ShadowPipelineModule[]),
  coaching: Object.freeze(['recommendation'] as readonly ShadowPipelineModule[]),
  safety: Object.freeze(['coaching'] as readonly ShadowPipelineModule[]),
});

/** What the orchestrator decided about one module, before it is given a shape. */
interface ResolvedModule {
  readonly status: ShadowModuleStatus;
  readonly reason: ShadowStageReason | null;
  readonly outputDigest: string | null;
  readonly failureCode: ContractErrorCode | null;
}

function moduleOutcomeFor(
  module: ShadowPipelineModule,
  resolved: ResolvedModule,
  elapsedMs: number,
): ShadowModuleOutcome {
  switch (resolved.status) {
    case 'completed':
      return {
        status: 'completed',
        module,
        contributed: true,
        reason: null,
        failureCode: null,
        outputDigest: resolved.outputDigest as string,
        elapsedMs,
      };
    case 'fell_back':
      return {
        status: 'fell_back',
        module,
        contributed: true,
        reason: resolved.reason as ShadowStageReason,
        failureCode: null,
        outputDigest: resolved.outputDigest as string,
        elapsedMs,
      };
    case 'timed_out':
      return {
        status: 'timed_out',
        module,
        contributed: false,
        reason: 'budget_exhausted',
        failureCode: null,
        outputDigest: null,
        elapsedMs,
        budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
      };
    case 'unavailable':
      return {
        status: 'unavailable',
        module,
        contributed: false,
        reason: resolved.reason as ShadowStageReason,
        failureCode: resolved.failureCode ?? 'INTERNAL_ERROR',
        outputDigest: null,
        elapsedMs,
      };
    case 'skipped':
      return {
        status: 'skipped',
        module,
        contributed: false,
        reason: resolved.reason as ShadowStageReason,
        failureCode: null,
        outputDigest: null,
        elapsedMs,
      };
  }
}

/**
 * Normalises what an adapter reported against what the runtime permitted.
 *
 * The two contract rules from the header, in one place so neither can be
 * applied at one call site and forgotten at another.
 */
function normalise(
  reported: ShadowModuleOutcome,
  decision: ModuleRuntimeDecision,
  elapsedMs: number,
  budgetMs: number,
): ResolvedModule {
  if (elapsedMs > budgetMs) {
    return { status: 'timed_out', reason: 'budget_exhausted', outputDigest: null, failureCode: null };
  }

  const status = reported.status;
  const contributes = status === 'completed' || status === 'fell_back';

  if (decision.mode === 'rules_only' && contributes) {
    return {
      status: 'fell_back',
      reason: decision.reason,
      outputDigest: reported.outputDigest,
      failureCode: null,
    };
  }

  return {
    status,
    reason: status === 'completed' ? null : reported.reason,
    outputDigest: contributes ? reported.outputDigest : null,
    failureCode: status === 'unavailable' ? reported.failureCode ?? 'INTERNAL_ERROR' : null,
  };
}

/**
 * Builds the run, bound to its ports.
 *
 * A factory rather than a bare function because `ShadowPipelineRun` — the seam
 * #46 and #47 depend on — takes only `(input, adapters)`. The ports are wiring,
 * not input, and they belong to whoever composes the pipeline.
 */
export function createShadowPipelineRun(deps: ShadowOrchestratorDeps): ShadowPipelineRun {
  return async function runShadowPipeline(
    input: ShadowPipelineInput,
    adapters: Readonly<Record<ShadowPipelineModule, ShadowModuleAdapter>>,
  ): Promise<ShadowReplayBundle> {
    // A run owns its ledger for its whole length and inherits nothing. Without
    // this, a proposal left over from a previous run would be attributed to a
    // module in this one and reported as `TRACE_PROPOSAL_UNEXPLAINED` — a
    // finding pointing at the wrong run.
    deps.ledger.reset();

    const controls: RuntimeControlSnapshot = {
      version: input.controls.version,
      featureFlags: input.controls.featureFlags,
      killSwitches: input.controls.killSwitches,
    };

    const runStartedAt = deps.clock.now();
    const moduleOutcomes = {} as Record<ShadowPipelineModule, ShadowModuleOutcome>;
    const stages: ShadowTraceStageRecord[] = [];
    const contributed = new Set<ShadowPipelineModule>();

    for (const module of SHADOW_PIPELINE_CHAIN) {
      const budgetMs = SHADOW_MODULE_TIMEOUT_BUDGET_MS[module];
      const decision = resolveModuleRuntime(module, controls);
      const startedAt = deps.clock.now();
      const proposalsBefore = deps.ledger.proposals().length;

      let resolved: ResolvedModule;

      if (SHADOW_MODULE_ROLES[module] === 'placeholder') {
        // Never invoked. A placeholder has nothing to complete, and calling its
        // descriptor to find that out would turn the registry into the routing
        // hub `moduleContracts` says it is deliberately not.
        resolved = {
          status: 'skipped',
          reason: 'module_placeholder',
          outputDigest: null,
          failureCode: null,
        };
      } else if (SHADOW_MODULE_PREREQUISITES[module].some((need) => !contributed.has(need))) {
        resolved = {
          status: 'skipped',
          reason: 'upstream_did_not_contribute',
          outputDigest: null,
          failureCode: null,
        };
      } else {
        const raced = await deps.deadline.race(
          () =>
            adapters[module]({
              module,
              runId: input.runId,
              scopeId: input.scopeId,
              startedAt,
              budgetMs,
              runtimeDecision: decision,
            }),
          budgetMs,
          module,
        );

        if (raced.kind === 'timed_out') {
          resolved = { status: 'timed_out', reason: 'budget_exhausted', outputDigest: null, failureCode: null };
        } else if (raced.kind === 'threw') {
          resolved = {
            status: 'unavailable',
            reason: 'module_error',
            outputDigest: null,
            failureCode: 'INTERNAL_ERROR',
          };
        } else {
          const endedForBudget = deps.clock.now();
          const spent = millisBetweenInstants(startedAt, endedForBudget) ?? 0;
          resolved = normalise(raced.value, decision, spent, budgetMs);
        }
      }

      const endedAt = deps.clock.now();
      const elapsedMs = millisBetweenInstants(startedAt, endedAt) ?? 0;
      const outcome = moduleOutcomeFor(module, resolved, elapsedMs);
      moduleOutcomes[module] = outcome;
      if (outcome.contributed) contributed.add(module);

      // Proposals made during this module's call are this module's, by
      // position: the ledger appends and never sorts, so the slice between the
      // two marks is exactly what this adapter proposed.
      //
      // A module that did not contribute keeps none of them. An adapter can
      // propose and then fail — `planning` proposes its plan before returning —
      // and a proposal from a module the outcome says produced nothing is
      // `PROPOSAL_FROM_NON_CONTRIBUTING_MODULE`. Rolling the ledger back here
      // rather than filtering at the end is what keeps the positions
      // contiguous: filtering renumbers the array the stage records already
      // cite, which is how the first draft produced
      // `TRACE_PROPOSAL_INDEX_OUT_OF_RANGE` on a perfectly good run.
      if (!outcome.contributed) deps.ledger.rollbackProposals(proposalsBefore);

      const proposalIndices: number[] = [];
      for (let index = proposalsBefore; index < deps.ledger.proposals().length; index += 1) {
        proposalIndices.push(index);
      }

      stages.push({
        module,
        position: SHADOW_PIPELINE_CHAIN_POSITION[module],
        runtimeDecision: decision,
        startedAt,
        endedAt,
        elapsedMs,
        budgetMs,
        status: outcome.status,
        // Read straight off the outcome, with no re-derivation. Both fields
        // were ternaries here until mutation testing showed neither could
        // fail: `moduleOutcomeFor` already sets `reason: null` for `completed`
        // and `outputDigest: null` for every non-contributing status, so the
        // guards were provably dead and two guards masking each other means
        // neither is covered — the finding `safetyContracts` records about its
        // own removed try/catch. One place decides these; this reads it.
        reason: outcome.reason,
        outputDigest: outcome.outputDigest,
        proposalIndices: Object.freeze(proposalIndices),
      });
    }

    const runEndedAt = deps.clock.now();
    const totalElapsedMs = millisBetweenInstants(runStartedAt, runEndedAt) ?? 0;

    const proposals: readonly ShadowEffectProposal[] = deps.ledger.proposals();
    const nonContributors = SHADOW_PIPELINE_CHAIN.filter((module) => !contributed.has(module));
    const failClosedGap = nonContributors.filter(
      (module) => SHADOW_MODULE_FAILURE_STANCE[module] === 'fail_closed',
    );

    const outcome = assembleOutcome({
      runId: input.runId,
      moduleOutcomes,
      nonContributors,
      failClosedGap,
      proposals,
      totalElapsedMs,
      safetyDigest: moduleOutcomes.safety.outputDigest,
      coachingDigest: moduleOutcomes.coaching.outputDigest,
    });

    // A withheld run has no deliverable, so `proposedEffects` does not exist on
    // it — and a stage that still cited a position into an array that is not
    // there would be `TRACE_PROPOSAL_INDEX_OUT_OF_RANGE`. The citations are
    // dropped rather than the proposals kept somewhere else, because the
    // contract puts proposals on the deliverable on purpose: a run that
    // delivered nothing proposed nothing anybody may act on.
    const withheld = outcome.completeness === 'withheld';
    const tracedStages = withheld
      ? stages.map((stage) => ({ ...stage, proposalIndices: Object.freeze([]) }))
      : stages;

    const trace: ShadowPipelineTrace = {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      runId: input.runId,
      scopeId: input.scopeId,
      // Null unless the run is attached to a participant session. At
      // `shadow_only` nobody saw it, so there is no session to attach to, and
      // `ALPHA_SESSION_AT_SHADOW_ONLY` reports the alternative.
      alphaSessionId: input.exposure.stage === 'shadow_only' ? null : input.alphaSessionId,
      recordedAt: runEndedAt,
      stages: Object.freeze(tracedStages),
    };

    const withoutDigest: ShadowReplayBundle = {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      runId: input.runId,
      recordedAt: runEndedAt,
      input,
      trace,
      outcome,
      // Hashed over the preimage below. The placeholder is never emitted: the
      // preimage does not read `bundleDigest`, so the digest cannot depend on
      // itself and this field's value here cannot reach the hash.
      bundleDigest: '',
    };

    return {
      ...withoutDigest,
      bundleDigest: deps.digest.hash(shadowReplayPreimage(withoutDigest)),
    };
  };
}

/**
 * Chooses the completeness variant.
 *
 * Order matters and is stated here rather than implied: the fail-closed check
 * comes before the "did everything contribute" check, because a run that lost
 * its guard is withheld regardless of how much else succeeded — and a run that
 * lost only degrade-open modules is degraded regardless of how many.
 */
function assembleOutcome(parts: {
  readonly runId: string;
  readonly moduleOutcomes: Record<ShadowPipelineModule, ShadowModuleOutcome>;
  readonly nonContributors: readonly ShadowPipelineModule[];
  readonly failClosedGap: readonly ShadowPipelineModule[];
  readonly proposals: readonly ShadowEffectProposal[];
  readonly totalElapsedMs: number;
  readonly safetyDigest: string | null;
  readonly coachingDigest: string | null;
}): ShadowPipelineOutcome {
  const base = {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    runId: parts.runId,
    moduleOutcomes: parts.moduleOutcomes,
    totalElapsedMs: parts.totalElapsedMs,
  } as const;

  const degradation = {
    nonContributingModules: parts.nonContributors as unknown as readonly [
      ShadowPipelineModule,
      ...ShadowPipelineModule[],
    ],
    crossedFailClosedModule: parts.failClosedGap.length > 0,
  };

  if (parts.failClosedGap.length > 0) {
    return {
      ...base,
      completeness: 'withheld',
      deliverable: null,
      degradation,
      withheldReason: 'fail_closed_module_did_not_contribute',
    };
  }

  const deliverable: ShadowDeliverable = {
    // Both digests are non-null here: `safety` and `coaching` both contributed,
    // or the fail-closed branch above would have taken this run.
    coachingDeliveryDigest: parts.coachingDigest as string,
    // The shadow run records that the gate ran and what it produced; the
    // disposition itself is the safety adapter's, carried on its digest. A
    // pipeline that re-derived a verdict here would be a second safety
    // judgement, which is the thing `lib/safety` exists to be the only one of.
    safetyDisposition: 'allow',
    // False for every `shadow_only` run, which is every run this sprint ships.
    // `DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY` reports the alternative.
    wouldHaveBeenShown: false,
    proposedEffects: parts.proposals,
  };

  if (parts.nonContributors.length === 0) {
    return { ...base, completeness: 'complete', deliverable, degradation: null, withheldReason: null };
  }

  return { ...base, completeness: 'degraded', deliverable, degradation, withheldReason: null };
}

export type { Instant };

/**
 * The eight module adapters (Sprint 11, issue #45).
 *
 * One `ShadowModuleAdapter` per member of `SHADOW_PIPELINE_CHAIN`, each of them
 * a translation between the run's carried state and one real module entry
 * point. The orchestrator owns the clock, the budget, the runtime decision and
 * the cascade; these own the calls.
 *
 * ── Which entry point each adapter binds to, and why that one ────────────
 *
 * `INTELLIGENCE_MODULE_CONTRACTS` names an `entryPoint` for five of the eight,
 * and those five are bound verbatim:
 *
 *   decomposition  `lib/decomposition/engine#proposeDecomposition`
 *   planning       `lib/planning/scheduler#schedulePlan`
 *   recommendation `lib/recommendation#selectRecommendation`
 *   coaching       `lib/coaching#deliverCoaching`
 *   safety         `lib/safety#evaluateSafetyGate`
 *
 * The other three need a decision, and the decisions are stated here rather
 * than buried:
 *
 *  - **capture** — the registry's capture descriptor names *no* entry point; it
 *    returns a literal disposition. The real deterministic capture path is
 *    `src/extraction/ruleBasedExtractor#extract`, and that is what this adapter
 *    binds to. Deliberately **not** `extractionService`, which can reach a
 *    local model over the network, and emphatically not
 *    `lib/services/captureService`, which writes commitments — a shadow run
 *    that called it would violate the sprint's headline criterion on its first
 *    stage. `ruleBasedExtractor` imports exactly one thing, a type, so it is
 *    also the cheapest possible closure to keep clean.
 *
 *  - **memory** — the registry names
 *    `lib/runtimeMemory/runtimeMemoryStore#createFileRuntimeMemoryStore`, and
 *    this adapter does **not** call it. That function calls `writeFileSync` and
 *    `randomUUID`; a factory for a store with `deleteScope` on it is not
 *    something a shadow adapter may hold. The adapter takes a
 *    `ShadowMemoryReader` — `retrieve` and nothing else — and the caller
 *    supplies it. The registry names the module's *production* entry point;
 *    the shadow chain needs its read half, and narrowing is how you take a read
 *    half from a type that also has a write half.
 *
 *  - **priority** — the registry calls it `not_implemented_in_sprint_00` and
 *    names no entry point, so `SHADOW_MODULE_ROLES` calls it a placeholder and
 *    the orchestrator skips it before any adapter is consulted. The adapter
 *    below exists and refuses, so that "the placeholder was skipped" is a
 *    property of the orchestrator that a test can break by removing the skip —
 *    rather than a hole where an adapter should be. **Note for integration:**
 *    `lib/priority/priorityScorer.ts` is real and shipped; the registry
 *    descriptor is stale. Updating it is `moduleContracts`' owner's call, not
 *    this track's, and until it happens the honest chain skips the stage.
 *
 * ── Why coaching and safety both call the gateway ────────────────────────
 *
 * `deliverCoaching` requires a `CoachingGatewayGate`, and a null gate is
 * refusal rather than permission — #38's `absentGatewayBlocksDelivery`. So the
 * coaching adapter wires the gate to `evaluateSafetyGate`, and the safety stage
 * then evaluates the delivered candidate itself. Two calls to one pure
 * function, and they are not the same judgement: coaching's gate judges what
 * coaching *proposes*, and the safety stage judges what coaching *delivered* —
 * which differ exactly when the delivery withholds. Timing them separately is
 * also what lets `safety` be a stage with its own budget and its own
 * fail-closed stance rather than a hidden cost inside coaching's.
 *
 * ── Digests ──────────────────────────────────────────────────────────────
 *
 * Every contributing adapter returns `outputDigest = digest.hash(canonicalize(payload))`.
 * The payload itself goes into the ledger for the modules downstream; only the
 * digest reaches the outcome, which is what keeps `ShadowPipelineOutcome`
 * inert and keeps raw text out of the artifact #46 reconciles logs against.
 */

import {
  SHADOW_PIPELINE_CHAIN,
  type ShadowEffectProposal,
  type ShadowModuleAdapter,
  type ShadowModuleOutcome,
  type ShadowPipelineModule,
} from '../../src/contracts/v1/shadowPipelineContracts';
import { extract } from '../../src/extraction/ruleBasedExtractor';
import { proposeDecomposition } from '../decomposition/engine';
import { schedulePlan } from '../planning/scheduler/scheduler';
import { currentFingerprints } from '../recommendation/selector/candidates';
import { DEFAULT_RECOMMENDATION_SELECTOR_CONFIG } from '../recommendation/selector/policy';
import { selectRecommendation } from '../recommendation/selector/select';
import {
  deliverCoaching,
  planCoaching,
  realizeCoachingPlan,
  toSafetyCandidate,
} from '../coaching';
import { evaluateSafetyGate } from '../safety';
import type { CoachingOutput, CoachingPlan } from '../../src/contracts/v1/coachingContracts';
import type { Plan } from '../../src/contracts/v1/planningContracts';
import type { SafetyCandidate, SafetyVerdict } from '../../src/contracts/v1/safetyContracts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes';
import type { RecommendationSelectorInput } from '../recommendation/selector/candidates';
import type { RecommendationSelection } from '../recommendation/selector/select';
import type { EvidenceNodeId } from '../../src/contracts/v1/recommendationContracts';

import type { ShadowDigest, ShadowRunLedger } from './ports';
import { canonicalize, type ShadowMemoryReader, type ShadowRunSeed } from './seed';

/**
 * What the recommendation stage hands downstream.
 *
 * The fingerprints travel with the selection because `planCoaching` needs them
 * and **a missing key fails closed**: without them every observed node reads as
 * unverifiable and the planner refuses with `SOURCE_RECOMMENDATION_STALE`. That
 * is #38 working correctly — it will not speak about evidence it cannot confirm
 * is still current — and it is the reason this pair is one payload rather than
 * two lookups. Deriving them in the coaching adapter instead would mean
 * rebuilding the selector input there, and two spellings of one input is how
 * two stages start disagreeing about what the run was about.
 */
export interface ShadowRecommendationPayload {
  readonly selection: RecommendationSelection;
  readonly fingerprints: Readonly<Record<EvidenceNodeId, string | null>>;
}

export interface ShadowAdapterDeps {
  readonly seed: ShadowRunSeed;
  readonly ledger: ShadowRunLedger;
  readonly digest: ShadowDigest;
  readonly memory: ShadowMemoryReader;
}

/**
 * A contributing outcome. `elapsedMs` is zero on purpose and is overwritten by
 * the orchestrator, which owns the clock — an adapter that reported its own
 * duration could report one inside its budget while having spent longer.
 */
function contributed(
  module: ShadowPipelineModule,
  payload: unknown,
  deps: ShadowAdapterDeps,
): ShadowModuleOutcome {
  deps.ledger.recordPayload(module, payload);
  return {
    status: 'completed',
    module,
    contributed: true,
    reason: null,
    failureCode: null,
    outputDigest: deps.digest.hash(canonicalize(payload)),
    elapsedMs: 0,
  };
}

function propose(
  deps: ShadowAdapterDeps,
  proposal: Omit<ShadowEffectProposal, 'status' | 'payloadDigest'> & { readonly of: unknown },
): void {
  deps.ledger.propose({
    status: 'proposed_never_applied',
    proposedBy: proposal.proposedBy,
    target: proposal.target,
    kind: proposal.kind,
    payloadDigest: deps.digest.hash(canonicalize(proposal.of)),
  });
}

/**
 * Capture: untrusted text into a structured extraction.
 *
 * `new Date(seed.now)` parses a supplied instant — the repo's ban is on the
 * zero-argument forms, and the boundary scan matches those specifically.
 * Nothing here reads a clock.
 */
function captureAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async () => {
    const result: ExtractionResult = extract(deps.seed.captureText, {
      now: new Date(deps.seed.now),
      timezone: deps.seed.timezone,
    });
    // A capture that found something would, live, have created a commitment.
    // Recorded as a proposal so the shadow run says what it *would* have done,
    // which is the only thing a shadow run is for.
    //
    // The condition is a **blank title**, and it is deliberately not
    // `type !== 'unknown' && title !== null`, which is what it said first.
    // `ruleBasedExtractor` never returns `'unknown'` and never returns a null
    // title — it answers `type: 'task'` with a possibly-empty title for every
    // input, including `''`. So that guard was true for every reachable input,
    // mutation testing found it by replacing the whole condition with `true`
    // and killing nothing, and a guard no test can reach is documentation of an
    // intention. A blank title is the one signal this extractor actually gives
    // for "there is nothing here", and it is reachable from whitespace input.
    const title = typeof result.title === 'string' ? result.title.trim() : '';
    if (title.length > 0) {
      propose(deps, {
        proposedBy: 'capture',
        target: 'commitment_store',
        kind: 'create',
        of: { title, dueAt: result.dueAt, type: result.type },
      });
    }
    return contributed('capture', result, deps);
  };
}

/** Memory: a bounded retrieval through a reader that has no write half. */
function memoryAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async () => {
    const records = deps.memory.retrieve({ scopeId: deps.seed.scopeId, now: deps.seed.now });
    return contributed('memory', records, deps);
  };
}

/**
 * Priority: the registry's placeholder.
 *
 * Never invoked — the orchestrator skips placeholders before consulting an
 * adapter — and it refuses rather than returning something, so that removing
 * the skip produces a loud failure instead of a plausible stub answer silently
 * counted as a contribution.
 */
function priorityAdapter(): ShadowModuleAdapter {
  return async () => {
    throw new Error(
      'the priority module is a placeholder in INTELLIGENCE_MODULE_CONTRACTS and must be skipped, not invoked',
    );
  };
}

/** Decomposition: one commitment's text, proposed as steps. */
function decompositionAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async (invocation) => {
    const capture = deps.ledger.readPayload('capture') as ExtractionResult | null;
    const proposal = await proposeDecomposition(
      {
        proposalId: `${invocation.runId}-decomposition`,
        commitmentId: `${invocation.runId}-commitment`,
        sourceText: capture?.rawText ?? deps.seed.captureText,
        // The deterministic path: a shadow run must not reach a model provider
        // it was not given, and `allowRulesFallback` left true would let one
        // silently substitute for the other.
        requestedEngine: 'rules',
      },
      // No `controls` argument, and that is a decision rather than an
      // omission. `proposeDecomposition` returns `runRules(null)` immediately
      // for `requestedEngine: 'rules'` — *before* it resolves its own runtime
      // decision — so a snapshot passed here could never be read. Mutation
      // testing found it: replacing `{ controls: deps.controls }` with `{}`
      // changed nothing any test could see, because nothing depended on it.
      // The stage's runtime decision is the orchestrator's, it is resolved
      // once, and it travels to the adapter on `invocation.runtimeDecision`.
    );
    propose(deps, {
      proposedBy: 'decomposition',
      target: 'proposal_store',
      kind: 'create',
      of: proposal,
    });
    return contributed('decomposition', proposal, deps);
  };
}

/** Planning: constraints and a config into a plan. */
function planningAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async () => {
    const plan: Plan = schedulePlan(
      {
        scopeId: deps.seed.scopeId,
        timezone: deps.seed.timezone,
        horizon: deps.seed.horizon,
        workingWindows: deps.seed.workingWindows,
        fixedEvents: deps.seed.fixedEvents,
        items: deps.seed.planningItems,
      },
      deps.seed.planningConfig,
    );
    propose(deps, { proposedBy: 'planning', target: 'plan_store', kind: 'schedule', of: plan });
    return contributed('planning', plan, deps);
  };
}

/** Recommendation: everything upstream, plus an explicit `now`, into one offer. */
function recommendationAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async (invocation) => {
    const selectorInput: RecommendationSelectorInput = {
      scopeId: deps.seed.scopeId,
      recommendationId: `${invocation.runId}-recommendation`,
      now: deps.seed.now,
      lifeState: deps.seed.lifeState,
      commitments: deps.seed.commitments,
      priorityScores: deps.seed.priorityScores,
      // Null when planning did not contribute. The selector's own type says the
      // plan is optional, which is why planning is not a prerequisite: a
      // planning failure costs quality, not the offer.
      plan: (deps.ledger.readPayload('planning') as Plan | null) ?? null,
    };
    // One config for both calls, spelled once. Two configs would let the
    // fingerprints be taken over a different candidate set than the selection,
    // and the coaching planner would then refuse for a reason that was really a
    // wiring mistake here.
    const config = DEFAULT_RECOMMENDATION_SELECTOR_CONFIG;
    const payload: ShadowRecommendationPayload = {
      selection: selectRecommendation(selectorInput, config),
      fingerprints: currentFingerprints(selectorInput, config),
    };
    return contributed('recommendation', payload, deps);
  };
}

/**
 * Coaching: plan, realize, deliver — with #39's gateway wired in as the gate.
 *
 * The three-step call is the module's documented path
 * (`planCoaching` → `realizeCoachingPlan` → `deliverCoaching`), not a shortcut
 * around it. A refusal at either of the first two steps is a *contribution*
 * with a withheld delivery, not a module failure: the module answered, and the
 * answer was "no". Reporting it as `unavailable` would make a working safety
 * refusal look like an outage.
 */
function coachingAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async (invocation) => {
    const upstream = deps.ledger.readPayload('recommendation') as ShadowRecommendationPayload | null;
    if (upstream === null) {
      throw new Error('coaching was invoked without a recommendation to speak about');
    }
    const recommendation = upstream.selection.recommendation;
    const candidateId = `${invocation.runId}-candidate`;

    const planned = planCoaching({
      recommendation,
      locale: 'en',
      now: deps.seed.now,
      // Fails closed when absent: every observed node would read as
      // unverifiable and the planner would refuse. Supplied from the same
      // candidate set the selection came from.
      currentFingerprints: upstream.fingerprints,
    });
    if (planned.outcome !== 'planned') {
      return contributed('coaching', { disposition: 'withheld', stage: 'planner', planned }, deps);
    }

    const plan: CoachingPlan = planned.plan;
    const realized = realizeCoachingPlan({
      plan,
      evidence: recommendation.evidence,
      basisAt: deps.seed.now,
    });
    if (realized.outcome !== 'realized') {
      return contributed('coaching', { disposition: 'withheld', stage: 'realizer', realized }, deps);
    }

    const output: CoachingOutput = realized.output;
    // The candidate is recorded whether or not delivery succeeds: the safety
    // stage judges what was produced, and a withheld delivery still produced
    // something for the gate to have refused.
    const candidate: SafetyCandidate = toSafetyCandidate(
      output,
      candidateId,
      deps.seed.attestedDecisions,
    );
    deps.ledger.recordPayload('safety', candidate);

    const delivery = deliverCoaching({
      candidateId,
      output,
      recommendation,
      plan,
      attestedDecisions: deps.seed.attestedDecisions,
      gate: (gated: SafetyCandidate): SafetyVerdict =>
        evaluateSafetyGate({
          request: safetyRequestFor(deps, `${invocation.runId}-coaching-gate`),
          candidate: gated,
          auditId: `${invocation.runId}-coaching-gate-audit`,
        }).verdict,
    });

    if (delivery.disposition === 'delivered') {
      propose(deps, {
        proposedBy: 'coaching',
        target: 'notification_queue',
        kind: 'notify',
        of: delivery.output,
      });
    }
    return contributed('coaching', delivery, deps);
  };
}

/** The request half of a gate call. One spelling, used by both callers. */
function safetyRequestFor(deps: ShadowAdapterDeps, requestId: string) {
  return {
    requestId,
    surface: 'coaching_message' as const,
    now: deps.seed.now,
    inputs: [],
    permittedSensitivity: deps.seed.permittedSensitivity,
    pressureBudget: deps.seed.pressureBudget,
    attestedDecisions: deps.seed.attestedDecisions,
  };
}

/**
 * Safety: the pipeline's own record of whether what coaching produced may be
 * shown.
 *
 * A `block` verdict is a **contribution**, not a failure. The module ran and
 * answered; the answer was no. Treating a refusal as an outage would make the
 * fail-closed stance fire on exactly the runs where the guard worked, which is
 * the inversion `SHADOW_MODULE_FAILURE_STANCE` exists to avoid.
 */
function safetyAdapter(deps: ShadowAdapterDeps): ShadowModuleAdapter {
  return async (invocation) => {
    const candidate = deps.ledger.readPayload('safety') as SafetyCandidate | null;
    if (candidate === null) {
      // Coaching answered and produced nothing to show — a planner or realizer
      // refusal. Reported as a skip naming its upstream, not as a failure: the
      // gate did not break, there was simply nothing for it to judge. The
      // pipeline then withholds, because `safety` is `fail_closed` and a run
      // with no gated output has nothing to deliver, which is the correct
      // answer rather than a degradation.
      return {
        status: 'skipped',
        module: 'safety',
        contributed: false,
        reason: 'upstream_did_not_contribute',
        failureCode: null,
        outputDigest: null,
        elapsedMs: 0,
      };
    }
    const result = evaluateSafetyGate({
      request: safetyRequestFor(deps, `${invocation.runId}-safety`),
      candidate,
      auditId: `${invocation.runId}-safety-audit`,
    });
    return contributed('safety', result, deps);
  };
}

/**
 * The adapter set, total over the chain.
 *
 * A `Record` keyed by `ShadowPipelineModule` rather than a list, so a module
 * added to `SHADOW_PIPELINE_CHAIN` without an adapter fails to typecheck rather
 * than throwing on the run that first reaches it.
 */
export function createShadowAdapterSet(
  deps: ShadowAdapterDeps,
): Record<ShadowPipelineModule, ShadowModuleAdapter> {
  const adapters: Record<ShadowPipelineModule, ShadowModuleAdapter> = {
    capture: captureAdapter(deps),
    memory: memoryAdapter(deps),
    priority: priorityAdapter(),
    decomposition: decompositionAdapter(deps),
    planning: planningAdapter(deps),
    recommendation: recommendationAdapter(deps),
    coaching: coachingAdapter(deps),
    safety: safetyAdapter(deps),
  };
  // Cheap and load-bearing: the type above guarantees the keys, and this
  // guarantees none of them is undefined at runtime after a bad merge.
  for (const module of SHADOW_PIPELINE_CHAIN) {
    if (typeof adapters[module] !== 'function') {
      throw new Error(`no shadow adapter is wired for ${module}`);
    }
  }
  return adapters;
}

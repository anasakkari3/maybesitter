/**
 * A deterministic fixture shadow pipeline, for #46's drills only.
 *
 * **This is not the orchestrator.** #45 owns `lib/shadowPipeline/**` and the
 * real `ShadowPipelineRun`; this file exists because #46's deliverables — the
 * kill-switch sweep, the SLO readings, the log reconciliation, the rollback
 * game day — are all *about* pipeline runs, and a track that waits for another
 * track's implementation before it can measure anything ships nothing. So the
 * run below is written to the contract's own seam:
 * `shadowDrillRun` has exactly the `ShadowPipelineRun` signature and
 * `createShadowDrillAdapters` produces exactly `ShadowModuleAdapter`s, which
 * makes the real orchestrator a drop-in substitution at integration rather than
 * a rewrite of everything that consumes it. Every drill and every test in this
 * track takes its run as an argument for that reason.
 *
 * Three properties it must have, and has:
 *
 *  1. **No clock and no randomness.** `startedAt` is an input, every stage
 *     instant is derived from it by adding a declared elapsed time, and the
 *     elapsed times are a literal table (`SHADOW_DRILL_ELAPSED_MS`). Two runs of
 *     the same plan produce byte-identical bundles, which is what lets the
 *     replay-divergence SLO have a fixture at all.
 *  2. **Contract-valid output.** Every bundle it produces reports no defects
 *     from `checkShadowPipelineOutcome`, `checkShadowTrace` and
 *     `checkShadowReplay`. The tests assert this on every drill run, not once:
 *     a timing fixture whose input is rejected by an earlier bound measures
 *     nothing, and a kill-switch sweep over malformed runs proves only that the
 *     harness is malformed.
 *  3. **The switches are real.** The runtime decision at each stage comes from
 *     the shipped `resolveModuleRuntime` reading a snapshot from the shipped
 *     `readRuntimeControls`, over an injected env rather than `process.env`.
 *     Nothing here re-implements a flag.
 *
 * The adapter, not the run, is what degrades when a switch is thrown — which is
 * the contract's division (`the orchestrator owns the clock and the timer; the
 * adapter owns the call`). `SHADOW_KILL_SWITCH_STANCE` is the documented stance
 * the fixture adapters implement, and `tests/operations/shadowKillSwitchDrill.test.ts`
 * is what holds them to it.
 */

import { createHash } from 'node:crypto';

import {
  MODULE_CONTRACT_VERSION,
  type ContractErrorCode,
} from '../../src/contracts/v1/moduleContracts';
import {
  readRuntimeControls,
  resolveModuleRuntime,
  type ModuleRuntimeDecision,
  type RuntimeControlEnv,
  type RuntimeControlSnapshot,
} from '../../src/contracts/v1/runtimeControls';
import { instantFromMillis } from '../../src/contracts/v1/safetyContracts';
import {
  SHADOW_MODULE_ROLES,
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_CHAIN_POSITION,
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_SCHEMA_VERSION,
  millisBetweenInstants,
  resolveShadowExposure,
  shadowReplayPreimage,
  type Instant,
  type SafetyDisposition,
  type ShadowDeliverable,
  type ShadowEffectProposal,
  type ShadowModuleAdapter,
  type ShadowModuleOutcome,
  type ShadowPipelineInput,
  type ShadowPipelineModule,
  type ShadowPipelineOutcome,
  type ShadowPipelineRun,
  type ShadowReplayBundle,
  type ShadowStageReason,
  type ShadowTraceStageRecord,
} from '../../src/contracts/v1/shadowPipelineContracts';

/* ── Digest ──────────────────────────────────────────────────────── */

/**
 * The one sha256 spelling this track owns, matching `SHADOW_DIGEST`.
 *
 * Local rather than imported for the reason every other module in this repo
 * keeps its own (`lib/planning/scheduler/digest.ts`,
 * `lib/feedback/feedbackEventStore.ts`): the preimage is the shared thing and
 * `shadowReplayPreimage` already owns it, so what is duplicated here is one
 * call to `createHash`, not a serialization convention two systems could
 * disagree about.
 */
export function shadowOperationsDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/* ── Time, as arithmetic over inputs ─────────────────────────────── */

const EPOCH_INSTANT = '1970-01-01T00:00:00.000Z';

function millisOfInstant(instant: Instant): number {
  const millis = millisBetweenInstants(EPOCH_INSTANT, instant);
  if (millis === null) throw new Error(`drill instant is not well-formed: ${String(instant)}`);
  return millis;
}

function instantAt(millis: number): Instant {
  const instant = instantFromMillis(millis);
  if (instant === null) throw new Error(`drill instant is out of range: ${String(millis)}`);
  return instant;
}

/* ── The declared shape of a fixture run ─────────────────────────── */

/**
 * How long each module takes when it answers, in milliseconds.
 *
 * Every value is strictly below that module's budget in
 * `SHADOW_MODULE_TIMEOUT_BUDGET_MS`, and the test pins both the literals and
 * the relation — a fixture that silently exceeded a budget would be rejected by
 * `checkShadowTrace` as `TRACE_COMPLETED_EXCEEDS_BUDGET`, and every measurement
 * taken over it would be a measurement of a malformed run.
 */
export const SHADOW_DRILL_ELAPSED_MS: Readonly<Record<ShadowPipelineModule, number>> = Object.freeze({
  capture: 750,
  memory: 200,
  priority: 0,
  decomposition: 600,
  planning: 450,
  recommendation: 400,
  coaching: 750,
  safety: 300,
});

/**
 * What a thrown kill switch does to each module, as data.
 *
 * This is the "documented stance" the kill-switch sweep asserts against, and it
 * has two rows rather than one because a module with nothing to fall back to
 * cannot fall back. `priority` is `placeholder` in `SHADOW_MODULE_ROLES`: a
 * rules-only stub is still a stub, so the honest record is `skipped`, and
 * `SHADOW_STAGE_REASON_ADMISSIBILITY` admits `kill_switch_active` for `skipped`
 * precisely so this can be said.
 *
 * **Precedence, stated because it is a judgement:** when a placeholder module
 * also has its switch thrown, the recorded reason is `kill_switch_active` and
 * not `module_placeholder`. The operator's action is the fact an on-call
 * engineer needs to see; "this module was always a stub" is true on every run
 * and therefore explains nothing about this one.
 */
export type ShadowKillSwitchStance = 'rules_only_fallback' | 'skipped_no_fallback';

export const SHADOW_KILL_SWITCH_STANCE: Readonly<
  Record<ShadowPipelineModule, ShadowKillSwitchStance>
> = Object.freeze({
  capture: 'rules_only_fallback',
  memory: 'rules_only_fallback',
  priority: 'skipped_no_fallback',
  decomposition: 'rules_only_fallback',
  planning: 'rules_only_fallback',
  recommendation: 'rules_only_fallback',
  coaching: 'rules_only_fallback',
  safety: 'rules_only_fallback',
});

/**
 * The dependencies that are *hard* — the ones where an absent upstream leaves
 * the module with nothing to act on, so it is skipped for
 * `upstream_did_not_contribute` rather than degraded.
 *
 * Deliberately three rows and not seven. `degrade_open` is the stance of every
 * module but `safety`, and a chain that skipped everything downstream of a lost
 * `memory` would be modelling a fail-closed pipeline while claiming a
 * degrade-open one. `decomposition` needs a captured commitment, `coaching`
 * needs something to coach about, and `safety` gates a *candidate* — with no
 * candidate there is nothing to gate, which is exactly how a run reaches
 * `withheld` for `fail_closed_module_did_not_contribute`.
 */
export const SHADOW_DRILL_HARD_DEPENDENCY: Readonly<
  Record<ShadowPipelineModule, ShadowPipelineModule | null>
> = Object.freeze({
  capture: null,
  memory: null,
  priority: null,
  decomposition: 'capture',
  planning: null,
  recommendation: null,
  coaching: 'recommendation',
  safety: 'coaching',
});

/** What a fixture module does when it is allowed to run. */
export type ShadowDrillBehaviour =
  | { readonly kind: 'answers' }
  | { readonly kind: 'errors'; readonly failureCode: ContractErrorCode }
  | { readonly kind: 'times_out' };

export interface ShadowDrillInvocation {
  readonly module: ShadowPipelineModule;
  readonly mode: ModuleRuntimeDecision['mode'];
  readonly fallbackReason: ShadowStageReason | null;
  /**
   * True only when the adapter took a model path: the runtime decision allowed
   * model execution *and* there is an implementation behind the module.
   */
  readonly modelExecuted: boolean;
}

export interface ShadowDrillAdapterSet {
  readonly adapters: Readonly<Record<ShadowPipelineModule, ShadowModuleAdapter>>;
  /** Mutated as the run proceeds; read after the run resolves. */
  readonly invocations: ShadowDrillInvocation[];
}

/* ── Outcome constructors ────────────────────────────────────────── */

function completedOutcome(module: ShadowPipelineModule, runId: string): ShadowModuleOutcome {
  return {
    status: 'completed',
    module,
    contributed: true,
    reason: null,
    failureCode: null,
    outputDigest: shadowOperationsDigest(`${runId}:${module}:completed`),
    elapsedMs: SHADOW_DRILL_ELAPSED_MS[module],
  };
}

function fellBackOutcome(
  module: ShadowPipelineModule,
  runId: string,
  reason: ShadowStageReason,
): ShadowModuleOutcome {
  return {
    status: 'fell_back',
    module,
    contributed: true,
    reason,
    failureCode: null,
    outputDigest: shadowOperationsDigest(`${runId}:${module}:fell_back:${reason}`),
    elapsedMs: SHADOW_DRILL_ELAPSED_MS[module],
  };
}

function skippedOutcome(module: ShadowPipelineModule, reason: ShadowStageReason): ShadowModuleOutcome {
  return {
    status: 'skipped',
    module,
    contributed: false,
    reason,
    failureCode: null,
    outputDigest: null,
    elapsedMs: 0,
  };
}

function timedOutOutcome(module: ShadowPipelineModule): ShadowModuleOutcome {
  return {
    status: 'timed_out',
    module,
    contributed: false,
    reason: 'budget_exhausted',
    failureCode: null,
    outputDigest: null,
    elapsedMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
    budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
  };
}

function unavailableOutcome(
  module: ShadowPipelineModule,
  failureCode: ContractErrorCode,
): ShadowModuleOutcome {
  return {
    status: 'unavailable',
    module,
    contributed: false,
    reason: 'module_error',
    failureCode,
    outputDigest: null,
    elapsedMs: SHADOW_DRILL_ELAPSED_MS[module],
  };
}

/* ── Adapters ────────────────────────────────────────────────────── */

/**
 * The eight fixture adapters, plus the log of what each one was asked to do.
 *
 * The log is the kill-switch evidence that the trace cannot give on its own: a
 * trace records the decision the orchestrator made, and `modelExecuted` records
 * what the *callee* did with it. A switch that appears in the trace while the
 * adapter went on calling the model is the failure this field exists to make
 * visible.
 */
export function createShadowDrillAdapters(
  behaviours: Readonly<Partial<Record<ShadowPipelineModule, ShadowDrillBehaviour>>> = {},
): ShadowDrillAdapterSet {
  const invocations: ShadowDrillInvocation[] = [];
  const adapters: Partial<Record<ShadowPipelineModule, ShadowModuleAdapter>> = {};

  for (const module of SHADOW_PIPELINE_CHAIN) {
    adapters[module] = async (invocation) => {
      const decision = invocation.runtimeDecision;
      const rulesOnly = decision.mode === 'rules_only';
      invocations.push({
        module,
        mode: decision.mode,
        fallbackReason: rulesOnly ? decision.reason : null,
        // A placeholder reaches no model however permissive the decision was:
        // recording `true` for it would make the one module in the chain with
        // nothing behind it look like the seven that have something.
        modelExecuted: !rulesOnly && SHADOW_MODULE_ROLES[module] === 'implemented',
      });

      // The switch is consulted **before** the role, so a thrown switch on a
      // placeholder is recorded as `kill_switch_active` and not as
      // `module_placeholder`: the operator's action explains this run, and
      // "always a stub" explains every run. The stance table is what decides
      // between falling back and skipping, so it is read on every rules-only
      // stage rather than being a comment about `priority`.
      if (rulesOnly) {
        return SHADOW_KILL_SWITCH_STANCE[module] === 'skipped_no_fallback'
          ? skippedOutcome(module, decision.reason)
          : fellBackOutcome(module, invocation.runId, decision.reason);
      }
      if (SHADOW_MODULE_ROLES[module] === 'placeholder') {
        return skippedOutcome(module, 'module_placeholder');
      }

      const behaviour = behaviours[module] ?? { kind: 'answers' };
      if (behaviour.kind === 'times_out') return timedOutOutcome(module);
      if (behaviour.kind === 'errors') return unavailableOutcome(module, behaviour.failureCode);
      return completedOutcome(module, invocation.runId);
    };
  }

  return {
    adapters: Object.freeze(adapters) as Readonly<Record<ShadowPipelineModule, ShadowModuleAdapter>>,
    invocations,
  };
}

/* ── The run ─────────────────────────────────────────────────────── */

const PROPOSAL_CANDIDATES = Object.freeze([
  Object.freeze({ proposedBy: 'planning' as const, target: 'plan_store' as const, kind: 'schedule' as const }),
  Object.freeze({ proposedBy: 'coaching' as const, target: 'notification_queue' as const, kind: 'notify' as const }),
]);

export interface ShadowDrillRunOptions {
  readonly safetyDisposition: SafetyDisposition;
}

/**
 * A `ShadowPipelineRun` over injected adapters. Same input, same bundle.
 *
 * `safetyDisposition` is an option rather than something read off a module,
 * because the fixture safety adapter returns a digest and not a verdict — the
 * real one will carry `SafetyDisposition` through, and #46 needs the field to
 * exist so `safety_block_rate` has something to read.
 */
export function createShadowDrillRun(
  options: ShadowDrillRunOptions = { safetyDisposition: 'allow' },
): ShadowPipelineRun {
  return async (input, adapters) => {
    const runId = input.runId;
    const startMillis = millisOfInstant(input.startedAt);
    let cursor = startMillis;

    const moduleOutcomes: Partial<Record<ShadowPipelineModule, ShadowModuleOutcome>> = {};
    const stageDrafts: {
      module: ShadowPipelineModule;
      decision: ModuleRuntimeDecision;
      startedAt: Instant;
      endedAt: Instant;
      outcome: ShadowModuleOutcome;
    }[] = [];
    const contributed: ShadowPipelineModule[] = [];

    for (const module of SHADOW_PIPELINE_CHAIN) {
      const decision = resolveModuleRuntime(module, input.controls as RuntimeControlSnapshot);
      const dependency = SHADOW_DRILL_HARD_DEPENDENCY[module];
      const dependencyMet = dependency === null || contributed.indexOf(dependency) !== -1;

      const stageStart = instantAt(cursor);
      const outcome = dependencyMet
        ? await adapters[module]({
            module,
            runId,
            scopeId: input.scopeId,
            startedAt: stageStart,
            budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
            runtimeDecision: decision,
          })
        : skippedOutcome(module, 'upstream_did_not_contribute');

      cursor += outcome.elapsedMs;
      moduleOutcomes[module] = outcome;
      if (outcome.contributed) contributed.push(module);
      stageDrafts.push({ module, decision, startedAt: stageStart, endedAt: instantAt(cursor), outcome });
    }

    const nonContributing = SHADOW_PIPELINE_CHAIN.filter(
      (module) => contributed.indexOf(module) === -1,
    );
    const safetyContributed = contributed.indexOf('safety') !== -1;

    const proposals: ShadowEffectProposal[] = [];
    for (const candidate of PROPOSAL_CANDIDATES) {
      if (!safetyContributed) break;
      if (contributed.indexOf(candidate.proposedBy) === -1) continue;
      proposals.push({
        status: 'proposed_never_applied',
        proposedBy: candidate.proposedBy,
        target: candidate.target,
        kind: candidate.kind,
        payloadDigest: shadowOperationsDigest(`${runId}:proposal:${candidate.proposedBy}`),
      });
    }

    const deliverable: ShadowDeliverable | null = safetyContributed
      ? {
          coachingDeliveryDigest: shadowOperationsDigest(`${runId}:delivery`),
          safetyDisposition: options.safetyDisposition,
          // Always false: `input.exposure.stage` is `shadow_only` in every drill,
          // and the stage means nobody is shown anything.
          wouldHaveBeenShown: false,
          proposedEffects: proposals,
        }
      : null;

    const stages: ShadowTraceStageRecord[] = stageDrafts.map((draft) => ({
      module: draft.module,
      position: SHADOW_PIPELINE_CHAIN_POSITION[draft.module],
      runtimeDecision: draft.decision,
      startedAt: draft.startedAt,
      endedAt: draft.endedAt,
      elapsedMs: draft.outcome.elapsedMs,
      budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[draft.module],
      status: draft.outcome.status,
      reason: draft.outcome.reason,
      outputDigest: draft.outcome.outputDigest,
      proposalIndices: proposals
        .map((proposal, index) => (proposal.proposedBy === draft.module ? index : -1))
        .filter((index) => index !== -1),
    }));

    if (nonContributing.length === 0) {
      // Unreachable while `priority` is a `placeholder` in `SHADOW_MODULE_ROLES`,
      // since a placeholder can never contribute. It is a throw rather than a
      // `complete` branch because the contract states that no Sprint 11 run can
      // be complete, and a harness that quietly produced one would be
      // manufacturing the shape the checkers exist to report.
      throw new Error('the fixture produced a run in which every module contributed');
    }
    const nonContributingModules: readonly [ShadowPipelineModule, ...ShadowPipelineModule[]] = [
      nonContributing[0],
      ...nonContributing.slice(1),
    ];
    const degradation = {
      nonContributingModules,
      crossedFailClosedModule: nonContributing.indexOf('safety') !== -1,
    };
    const totalElapsedMs = cursor - startMillis;
    const base = {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      runId,
      moduleOutcomes: moduleOutcomes as Readonly<Record<ShadowPipelineModule, ShadowModuleOutcome>>,
      totalElapsedMs,
    } as const;

    const outcome: ShadowPipelineOutcome =
      deliverable === null
        ? {
            ...base,
            completeness: 'withheld',
            deliverable: null,
            degradation,
            withheldReason: 'fail_closed_module_did_not_contribute',
          }
        : {
            ...base,
            completeness: 'degraded',
            deliverable,
            degradation,
            withheldReason: null,
          };

    const trace = {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      runId,
      scopeId: input.scopeId,
      alphaSessionId: input.alphaSessionId,
      recordedAt: instantAt(cursor),
      stages,
    };

    const draft: ShadowReplayBundle = {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      runId,
      recordedAt: trace.recordedAt,
      input,
      trace,
      outcome,
      bundleDigest: '',
    };
    return { ...draft, bundleDigest: shadowOperationsDigest(shadowReplayPreimage(draft)) };
  };
}

/* ── Plans: the caller-facing shape ──────────────────────────────── */

export interface ShadowDrillPlan {
  readonly runId: string;
  readonly scopeId: string;
  readonly startedAt: Instant;
  /** Read by the shipped `readRuntimeControls`; never `process.env`. */
  readonly env: RuntimeControlEnv;
  readonly behaviours?: Readonly<Partial<Record<ShadowPipelineModule, ShadowDrillBehaviour>>>;
  readonly safetyDisposition?: SafetyDisposition;
  /** What the run cost, in micros. No shape in the contract carries this — see the docs. */
  readonly costMicros?: number;
}

export interface ShadowDrillRunResult {
  readonly bundle: ShadowReplayBundle;
  readonly controls: RuntimeControlSnapshot;
  readonly invocations: readonly ShadowDrillInvocation[];
  readonly costMicros: number;
}

/**
 * Every module's feature flag on, every kill switch off — the env a drill starts
 * from.
 *
 * Built as env strings rather than as a snapshot literal so that
 * `readRuntimeControls` does the parsing: `MODULE_FEATURE_FLAG_DEFAULTS` has
 * every module but `capture` **off**, so a drill that hand-built a snapshot
 * would be measuring a pipeline that was already rules-only everywhere and
 * would find a thrown kill switch changed nothing.
 */
export function shadowDrillEnv(
  overrides: Readonly<Record<string, string>> = {},
): RuntimeControlEnv {
  const env: Record<string, string> = {};
  for (const module of SHADOW_PIPELINE_CHAIN) {
    const token = module.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
    env[`MAYBESITTER_FEATURE_${token}`] = 'true';
    env[`MAYBESITTER_KILL_SWITCH_${token}`] = 'false';
  }
  return { ...env, ...overrides };
}

/** The env key that throws one module's kill switch. */
export function killSwitchEnvKey(module: ShadowPipelineModule): string {
  return `MAYBESITTER_KILL_SWITCH_${module.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

export function shadowDrillInput(
  plan: ShadowDrillPlan,
  controls: RuntimeControlSnapshot,
): ShadowPipelineInput {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    runId: plan.runId,
    scopeId: plan.scopeId,
    startedAt: plan.startedAt,
    controls,
    exposure: resolveShadowExposure({
      participantId: 'drill-participant',
      stage: 'shadow_only',
      cohortSize: 0,
      pilotDecision: { allowed: true, reason: 'authorized' },
      consent: {
        state: 'withheld',
        participantId: 'drill-participant',
        scopes: [],
        grantedAt: null,
        revokedAt: null,
      },
    }),
    inputDigest: shadowOperationsDigest(`${plan.runId}:input`),
    alphaSessionId: null,
  };
}

/**
 * Run one fixture plan.
 *
 * `run` is injected and defaults to the fixture: at integration, #45's real
 * `ShadowPipelineRun` is passed here and every drill above this line keeps
 * working unchanged. That substitution is the whole reason this signature
 * exists.
 */
export async function runShadowDrill(
  plan: ShadowDrillPlan,
  run: ShadowPipelineRun = createShadowDrillRun({
    safetyDisposition: plan.safetyDisposition ?? 'allow',
  }),
): Promise<ShadowDrillRunResult> {
  const controls = readRuntimeControls(plan.env);
  const { adapters, invocations } = createShadowDrillAdapters(plan.behaviours ?? {});
  const bundle = await run(shadowDrillInput(plan, controls), adapters);
  return {
    bundle,
    controls,
    invocations,
    costMicros: plan.costMicros ?? 0,
  };
}

/** Pinned so a reader of a bundle can tell which contract version produced it. */
export const SHADOW_DRILL_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;

/**
 * The shadow pipeline contract: vocabularies, budgets, the structural
 * impossibilities, the trace/outcome cross-check, replay determinism, and the
 * three tracks' surfaces.
 *
 * The tests here are about properties the *contract* claims. Following the
 * Sprint 08 lesson that a vocabulary is only as real as the assertion that
 * enumerates it, every closed set is pinned with exact `deepEqual` — adding a
 * module, a status, a stage reason, a defect code or an invariant is a decision
 * this suite forces into review rather than lets drift in.
 *
 * Two disciplines this file follows deliberately, both from Sprint 10's review:
 *
 *  1. **Fixtures that probe a limit derive their size from the constant, and
 *     the constant's value is additionally pinned against a literal.** Building
 *     a probe out of the constant it tests proves only that arithmetic works —
 *     Sprint 10 shipped every floor mutable in both directions that way. So
 *     `budgets and limits are pinned as values` holds each number against a
 *     literal, and the probes below derive from the constants so they stay
 *     correct when a reviewed change moves one.
 *
 *  2. **Structural impossibilities are demonstrated, not asserted.** Every
 *     `@ts-expect-error` below is a shape this contract claims cannot exist; if
 *     a future edit makes one of them compile, the directive itself becomes an
 *     error and this file fails. That is the only way a type-level guarantee can
 *     be regression-tested.
 *
 * The restatements this contract makes of `lib/` shapes — a contract may not
 * import `lib/`, this test may and does — are pinned here: the pilot stop
 * reasons in both directions by assignability, the stage caps against the
 * imported constants, the safe-code pattern as a superset of the shipped one,
 * and the forbidden log key classes by driving each through the shipped
 * `validateAnalyticsEvent`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SLO_SAMPLE_COUNT,
  PERSONALIZATION_INVARIANTS,
  SAFETY_DISPOSITIONS,
  SHADOW_COMPLETENESS_STATES,
  SHADOW_CONFIGURATION_DEFECT_CODES,
  SHADOW_CONSENT_SCOPES,
  SHADOW_CONSENT_STATES,
  SHADOW_DEFECT_PARTITIONS,
  SHADOW_DIGEST,
  SHADOW_EFFECT_KINDS,
  SHADOW_EFFECT_TARGETS,
  SHADOW_ENGAGEMENT_MEASURE_CLASSES,
  SHADOW_EVIDENCE_DEFECT_CODES,
  SHADOW_EVIDENCE_PILLARS,
  SHADOW_EVIDENCE_SUPPORTS,
  SHADOW_EXPOSURE_DEFECT_CODES,
  SHADOW_EXPOSURE_POLICY,
  SHADOW_EXPOSURE_REASONS,
  SHADOW_EXPOSURE_STAGES,
  SHADOW_FALLBACK_REASON_COVERAGE,
  SHADOW_FORBIDDEN_LOG_KEY_CLASSES,
  SHADOW_LOG_RECONCILIATION_FIELDS,
  SHADOW_MEASURE_CLASSES,
  SHADOW_MODULE_FAILURE_STANCE,
  SHADOW_MODULE_ROLES,
  SHADOW_MODULE_STATUSES,
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_OUTCOME_DEFECT_CODES,
  SHADOW_OUTCOME_INERTNESS,
  SHADOW_PILOT_STOP_REASONS,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_CHAIN_POSITION,
  SHADOW_PIPELINE_CONTRACT_VERSION,
  SHADOW_PIPELINE_INPUT_POLICY,
  SHADOW_PIPELINE_INVARIANTS,
  SHADOW_PIPELINE_LIMITS,
  SHADOW_PIPELINE_LIMIT_NAMES,
  SHADOW_PIPELINE_SCHEMA_VERSION,
  SHADOW_PIPELINE_TOTAL_BUDGET_MS,
  SHADOW_PROPOSAL_INERTNESS,
  SHADOW_RECEIPT_DEFECT_CODES,
  SHADOW_RECONCILIATION_DEFECT_CODES,
  SHADOW_RELEASE_DECISIONS,
  SHADOW_RELEASE_GATE_INVARIANT,
  SHADOW_REPLAY_DEFECT_CODES,
  SHADOW_REPLAY_PREIMAGE_SECTIONS,
  SHADOW_SAFE_CODE,
  SHADOW_SLO_COMPARISONS,
  SHADOW_SLO_DEFECT_CODES,
  SHADOW_SLO_INCONCLUSIVE_REASONS,
  SHADOW_SLO_METRICS,
  SHADOW_SLO_OWNER_TEAMS,
  SHADOW_SLO_READING_STATUSES,
  SHADOW_SLO_WINDOWS,
  SHADOW_SLO_WINDOW_MILLIS,
  SHADOW_STAGE_PARTICIPANT_CAP,
  SHADOW_STAGE_PARTICIPANT_FLOOR,
  SHADOW_STAGE_REASONS,
  SHADOW_STAGE_REASON_ADMISSIBILITY,
  SHADOW_STAGE_REASON_COVERAGE,
  SHADOW_STATUS_CONTRIBUTION,
  SHADOW_TRACE_ALPHA_SEAM,
  SHADOW_TRACE_DEFECT_CODES,
  SHADOW_WITHHOLD_REASONS,
  SHADOW_WRITE_SURFACE,
  checkShadowBudgetTable,
  checkShadowEvidencePackage,
  checkShadowExposureDecision,
  checkShadowInertness,
  checkShadowLogReconciliation,
  checkShadowPipelineOutcome,
  checkShadowReplay,
  checkShadowSloDefinition,
  checkShadowSloReading,
  checkShadowStudyConsent,
  checkShadowStudyDeletionReceipt,
  checkShadowTrace,
  contributingModules,
  nonContributingModules,
  resolveShadowExposure,
  shadowReplayPreimage,
  shadowSloBreached,
  type ShadowCompleteOutcome,
  type ShadowDegradedOutcome,
  type ShadowEffectProposal,
  type ShadowEvidencePackage,
  type ShadowExposureDecision,
  type ShadowExposureStage,
  type ShadowInertValue,
  type ShadowModuleOutcome,
  type ShadowModuleStatus,
  type ShadowPipelineDefect,
  type ShadowPipelineDefectCode,
  type ShadowPipelineInput,
  type ShadowPipelineModule,
  type ShadowPipelineOutcome,
  type ShadowPipelineTrace,
  type ShadowPilotDecision,
  type ShadowReplayBundle,
  type ShadowReplayObservation,
  type ShadowRevokedConsent,
  type ShadowSloDefinition,
  type ShadowSloReading,
  type ShadowStudyConsent,
  type ShadowStudyDeletionReceipt,
  type ShadowTraceStageRecord,
  type ShadowWithheldOutcome,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  INTELLIGENCE_MODULES,
  MODULE_CONTRACT_VERSION,
} from '../../src/contracts/v1/moduleContracts.ts';
import { resolveModuleRuntime } from '../../src/contracts/v1/runtimeControls.ts';
import { ALPHA_TRACE_VERSION } from '../../src/contracts/v1/alphaTraceContracts.ts';
import { ANALYTICS_EVENT_CONTRACT_VERSION } from '../../src/contracts/v1/analyticsEventContracts.ts';
import { validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents.ts';
import {
  CLOSED_PILOT_MAXIMUM,
  CLOSED_PILOT_MINIMUM,
  createPilotAuditEvent,
  type PilotExposureDecision,
  type PilotStopReason,
} from '../../lib/pilot/closedPilotControls.ts';

/* ── The lib/ restatements, pinned at compile time ───────────────── */

/**
 * Mutual assignability between this contract's restated pilot vocabulary and
 * the shipped one. Both directions, because a one-way check passes while the
 * two lists drift apart in the untested direction — which is how a "named
 * duplication" becomes an unnamed one.
 */
const _pilotReasonToShadow: (typeof SHADOW_PILOT_STOP_REASONS)[number] =
  'quiet_mode' as PilotStopReason;
const _shadowReasonToPilot: PilotStopReason =
  'quiet_mode' as (typeof SHADOW_PILOT_STOP_REASONS)[number];
const _pilotDecisionToShadow: ShadowPilotDecision = { allowed: false, reason: 'revoked' } as PilotExposureDecision;
const _shadowDecisionToPilot: PilotExposureDecision = { allowed: false, reason: 'revoked' } as ShadowPilotDecision;

/* ── Fixtures ────────────────────────────────────────────────────── */

const RUN_ID = 'run-2027-01-05.0001';
const SCOPE_ID = 'scope-a';
const PARTICIPANT_ID = 'participant-01';
const STARTED_AT = '2027-01-05T09:00:00.000Z';
const DIGEST = 'a1b2c3d4e5f60718';
const OTHER_DIGEST = 'b1b2c3d4e5f60719';

/** `new Date(millis)` reads no clock; the ban is on the zero-argument form. */
function instantAfter(startMillisOffset: number): string {
  return new Date(Date.parse(STARTED_AT) + startMillisOffset).toISOString();
}

function controls(): ShadowPipelineInput['controls'] {
  const featureFlags: Record<string, boolean> = {};
  const killSwitches: Record<string, boolean> = {};
  for (const module of INTELLIGENCE_MODULES) {
    featureFlags[module] = true;
    killSwitches[module] = false;
  }
  return {
    version: MODULE_CONTRACT_VERSION,
    featureFlags: featureFlags as ShadowPipelineInput['controls']['featureFlags'],
    killSwitches: killSwitches as ShadowPipelineInput['controls']['killSwitches'],
  };
}

function shadowOnlyExposure(): ShadowExposureDecision {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    participantId: PARTICIPANT_ID,
    stage: 'shadow_only',
    cap: SHADOW_STAGE_PARTICIPANT_CAP.shadow_only,
    cohortSize: 0,
    consentState: 'withheld',
    allowed: false,
    reason: 'stage_is_shadow_only',
  };
}

function moduleOutcome(
  module: ShadowPipelineModule,
  status: ShadowModuleStatus = 'completed',
): ShadowModuleOutcome {
  const elapsedMs = Math.floor(SHADOW_MODULE_TIMEOUT_BUDGET_MS[module] / 2);
  switch (status) {
    case 'completed':
      return { status, module, contributed: true, reason: null, failureCode: null, outputDigest: DIGEST, elapsedMs };
    case 'fell_back':
      return {
        status,
        module,
        contributed: true,
        reason: 'feature_disabled',
        failureCode: null,
        outputDigest: DIGEST,
        elapsedMs,
      };
    case 'skipped':
      return {
        status,
        module,
        contributed: false,
        reason: 'module_placeholder',
        failureCode: null,
        outputDigest: null,
        elapsedMs: 0,
      };
    case 'timed_out':
      return {
        status,
        module,
        contributed: false,
        reason: 'budget_exhausted',
        failureCode: null,
        outputDigest: null,
        elapsedMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
        budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
      };
    case 'unavailable':
      return {
        status,
        module,
        contributed: false,
        reason: 'module_error',
        failureCode: 'INTERNAL_ERROR',
        outputDigest: null,
        elapsedMs,
      };
  }
}

function proposal(module: ShadowPipelineModule = 'planning'): ShadowEffectProposal {
  return {
    status: 'proposed_never_applied',
    proposedBy: module,
    target: 'plan_store',
    kind: 'schedule',
    payloadDigest: DIGEST,
  };
}

/**
 * The realistic Sprint 11 run: every implemented module completed, `priority`
 * skipped because it is a placeholder. Deliberately `degraded` rather than
 * `complete` — see the chain's doc comment: a chain containing a stub cannot
 * produce a complete run, and pretending otherwise is the dishonesty the
 * placeholder role exists to prevent.
 */
function degradedOutcome(): ShadowDegradedOutcome {
  const moduleOutcomes = {} as Record<ShadowPipelineModule, ShadowModuleOutcome>;
  for (const module of SHADOW_PIPELINE_CHAIN) {
    moduleOutcomes[module] = moduleOutcome(
      module,
      SHADOW_MODULE_ROLES[module] === 'placeholder' ? 'skipped' : 'completed',
    );
  }
  const placeholders = SHADOW_PIPELINE_CHAIN.filter(
    (module) => SHADOW_MODULE_ROLES[module] === 'placeholder',
  );
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    runId: RUN_ID,
    completeness: 'degraded',
    moduleOutcomes,
    deliverable: {
      coachingDeliveryDigest: DIGEST,
      safetyDisposition: 'allow',
      wouldHaveBeenShown: false,
      proposedEffects: [proposal()],
    },
    degradation: {
      nonContributingModules: placeholders as unknown as readonly [
        ShadowPipelineModule,
        ...ShadowPipelineModule[],
      ],
      crossedFailClosedModule: false,
    },
    withheldReason: null,
    totalElapsedMs: 3_000,
  };
}

function stageFor(
  module: ShadowPipelineModule,
  outcome: ShadowPipelineOutcome,
  proposalIndices: readonly number[] = [],
): ShadowTraceStageRecord {
  const entry = outcome.moduleOutcomes[module];
  const elapsedMs = entry.elapsedMs;
  return {
    module,
    position: SHADOW_PIPELINE_CHAIN_POSITION[module],
    runtimeDecision: resolveModuleRuntime(module, {
      version: MODULE_CONTRACT_VERSION,
      featureFlags: controls().featureFlags,
      killSwitches: controls().killSwitches,
    }),
    startedAt: instantAfter(SHADOW_PIPELINE_CHAIN_POSITION[module] * 2_000),
    endedAt: instantAfter(SHADOW_PIPELINE_CHAIN_POSITION[module] * 2_000 + elapsedMs),
    elapsedMs,
    budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
    status: entry.status,
    reason: entry.status === 'completed' ? null : entry.reason,
    outputDigest: entry.contributed ? DIGEST : null,
    proposalIndices,
  };
}

function traceFor(outcome: ShadowPipelineOutcome): ShadowPipelineTrace {
  const proposals = outcome.deliverable === null ? [] : outcome.deliverable.proposedEffects;
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    runId: outcome.runId,
    scopeId: SCOPE_ID,
    alphaSessionId: null,
    recordedAt: instantAfter(20_000),
    stages: SHADOW_PIPELINE_CHAIN.map((module) =>
      stageFor(
        module,
        outcome,
        proposals.flatMap((candidate, index) => (candidate.proposedBy === module ? [index] : [])),
      ),
    ),
  };
}

function bundleFor(outcome: ShadowPipelineOutcome): ShadowReplayBundle {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    runId: outcome.runId,
    recordedAt: instantAfter(20_000),
    input: {
      version: SHADOW_PIPELINE_CONTRACT_VERSION,
      schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
      runId: outcome.runId,
      scopeId: SCOPE_ID,
      startedAt: STARTED_AT,
      controls: controls(),
      exposure: shadowOnlyExposure(),
      inputDigest: DIGEST,
      alphaSessionId: null,
    },
    trace: traceFor(outcome),
    outcome,
    bundleDigest: DIGEST,
  };
}

function observationFor(bundle: ShadowReplayBundle): ShadowReplayObservation {
  return {
    outcome: bundle.outcome,
    trace: bundle.trace,
    controls: bundle.input.controls,
    bundleDigest: bundle.bundleDigest,
  };
}

function sloDefinition(): ShadowSloDefinition {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    sloId: 'shadow-latency-p95',
    metric: 'pipeline_latency_p95_ms',
    comparison: 'at_most',
    threshold: 5_000,
    window: 'rolling_24h',
    minimumSampleCount: MIN_SLO_SAMPLE_COUNT,
    owner: { team: 'quality', rotationId: 'quality-primary', escalationRotationId: 'quality-secondary' },
    killSwitchModule: 'coaching',
  };
}

function measuredReading(overrides: Partial<ShadowSloReading> = {}): ShadowSloReading {
  return {
    status: 'measured',
    sloId: 'shadow-latency-p95',
    value: 3_000,
    sampleCount: MIN_SLO_SAMPLE_COUNT,
    breached: false,
    inconclusiveReason: null,
    windowStart: instantAfter(-SHADOW_SLO_WINDOW_MILLIS.rolling_24h),
    observedAt: STARTED_AT,
    ...overrides,
  } as ShadowSloReading;
}

function grantedConsent(): ShadowStudyConsent {
  return {
    state: 'granted',
    participantId: PARTICIPANT_ID,
    scopes: ['shadow_execution', 'feedback_study'],
    grantedAt: STARTED_AT,
    revokedAt: null,
  };
}

function evidencePackage(
  decision: ShadowEvidencePackage['decision'] = 'hold',
): ShadowEvidencePackage {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    packageId: 'package-s11-01',
    assembledAt: STARTED_AT,
    stage: 'shadow_only',
    decision,
    evidence: {
      quality: [
        { pillar: 'quality', measureClass: 'user_judgement', support: 'go', sloReading: null, citation: 'study-helpfulness' },
      ],
      safety: [
        { pillar: 'safety', measureClass: 'safety_outcome', support: 'go', sloReading: null, citation: 'redteam-s11' },
      ],
      reliability: [
        {
          pillar: 'reliability',
          measureClass: 'reliability_signal',
          support: 'go',
          sloReading: measuredReading(),
          citation: 'slo-latency-p95',
        },
      ],
    },
  };
}

function deletionReceipt(): ShadowStudyDeletionReceipt {
  return {
    version: SHADOW_PIPELINE_CONTRACT_VERSION,
    schemaVersion: SHADOW_PIPELINE_SCHEMA_VERSION,
    participantId: PARTICIPANT_ID,
    deletedAt: STARTED_AT,
    personalization: {
      version: MODULE_CONTRACT_VERSION,
      schemaVersion: 'personalization-v1',
      scopeId: SCOPE_ID,
      deletedAt: STARTED_AT,
      remainingFeedbackEventCount: 0,
      remainingRuntimeMemoryRecordCount: 0,
      remainingPersistedProfileCount: 0,
      emptyStateDigest: DIGEST,
    },
    remainingTraceCount: 0,
    remainingReplayBundleCount: 0,
    remainingStudyResponseCount: 0,
    emptyStateDigest: DIGEST,
  };
}

function codesOf(defects: readonly ShadowPipelineDefect[]): readonly ShadowPipelineDefectCode[] {
  return defects.map((finding) => finding.code);
}

/** Structured tampering: deep-copy, break one thing, hand it back untyped. */
function tampered<T>(base: T, mutate: (draft: Record<string, unknown>) => void): T {
  const draft = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mutate(draft);
  return draft as unknown as T;
}

/* ── Versions ────────────────────────────────────────────────────── */

test('the schema version is the declared literal and the contract version is the module one', () => {
  assert.equal(SHADOW_PIPELINE_SCHEMA_VERSION, 'shadow-pipeline-v1');
  assert.equal(SHADOW_PIPELINE_CONTRACT_VERSION, MODULE_CONTRACT_VERSION);
  // Spelled as a literal here for the reason the module descriptors record: an
  // import back from `moduleContracts` would close a cycle that ESM resolves as
  // a TDZ ReferenceError `tsc` reports nothing about.
});

/* ── Closed vocabularies: an addition is a decision ──────────────── */

test('the chain is exactly these eight modules, in this order', () => {
  assert.deepEqual(SHADOW_PIPELINE_CHAIN, [
    'capture',
    'memory',
    'priority',
    'decomposition',
    'planning',
    'recommendation',
    'coaching',
    'safety',
  ]);
  for (const module of SHADOW_PIPELINE_CHAIN) {
    assert.ok(INTELLIGENCE_MODULES.includes(module), `${module} is not a known intelligence module`);
  }
  // Safety runs last because the gate is defined over a candidate and coaching
  // is what produces one.
  assert.equal(SHADOW_PIPELINE_CHAIN[SHADOW_PIPELINE_CHAIN.length - 1], 'safety');
});

test('the module statuses, stage reasons, withhold reasons and completeness states are closed', () => {
  assert.deepEqual(SHADOW_MODULE_STATUSES, [
    'completed',
    'fell_back',
    'skipped',
    'timed_out',
    'unavailable',
  ]);
  assert.deepEqual(SHADOW_STAGE_REASONS, [
    'feature_disabled',
    'kill_switch_active',
    'module_unavailable',
    'module_placeholder',
    'upstream_did_not_contribute',
    'budget_exhausted',
    'module_error',
    'exposure_not_granted',
  ]);
  assert.deepEqual(SHADOW_WITHHOLD_REASONS, [
    'fail_closed_module_did_not_contribute',
    'chain_never_started',
    'total_budget_exhausted',
  ]);
  assert.deepEqual(SHADOW_COMPLETENESS_STATES, ['complete', 'degraded', 'withheld']);
  assert.equal(SHADOW_STAGE_REASON_COVERAGE, true);
  assert.equal(SHADOW_FALLBACK_REASON_COVERAGE, true);
});

test('the runtime-control fallback reasons are the first three stage reasons, not a second copy', () => {
  // `RulesOnlyFallbackReason` is imported into `ShadowStageReason`, so this is a
  // containment claim rather than a duplication: a fourth reason added to
  // `runtimeControls` fails `_FallbackReasonsCovered` at compile time, and this
  // assertion records which three the union starts from.
  assert.deepEqual(SHADOW_STAGE_REASONS.slice(0, 3), [
    'feature_disabled',
    'kill_switch_active',
    'module_unavailable',
  ]);
});

test('the effect, exposure, consent, SLO and evidence vocabularies are closed', () => {
  assert.deepEqual(SHADOW_EFFECT_TARGETS, [
    'commitment_store',
    'proposal_store',
    'plan_store',
    'runtime_memory',
    'notification_queue',
    'feedback_log',
  ]);
  assert.deepEqual(SHADOW_EFFECT_KINDS, ['create', 'update', 'supersede', 'schedule', 'notify']);
  assert.deepEqual(SHADOW_EXPOSURE_STAGES, ['shadow_only', 'internal_dogfood', 'closed_pilot']);
  assert.deepEqual(SHADOW_CONSENT_STATES, ['granted', 'withheld', 'revoked']);
  assert.deepEqual(SHADOW_CONSENT_SCOPES, ['shadow_execution', 'feedback_study', 'trace_retention']);
  assert.deepEqual(SHADOW_SLO_METRICS, [
    'pipeline_latency_p95_ms',
    'module_timeout_rate',
    'module_fallback_rate',
    'pipeline_degraded_rate',
    'pipeline_withheld_rate',
    'safety_block_rate',
    'replay_divergence_rate',
    'trace_completeness_rate',
    'shadow_cost_micros_per_run',
  ]);
  assert.deepEqual(SHADOW_SLO_COMPARISONS, ['at_most', 'at_least']);
  assert.deepEqual(SHADOW_SLO_WINDOWS, ['rolling_1h', 'rolling_24h', 'rolling_7d']);
  assert.deepEqual(SHADOW_SLO_OWNER_TEAMS, ['backend', 'quality', 'product']);
  assert.deepEqual(SHADOW_SLO_INCONCLUSIVE_REASONS, [
    'insufficient_sample',
    'no_data_in_window',
    'collector_unavailable',
  ]);
  assert.deepEqual(SHADOW_SLO_READING_STATUSES, ['measured', 'inconclusive']);
  assert.deepEqual(SHADOW_EVIDENCE_PILLARS, ['quality', 'safety', 'reliability']);
  assert.deepEqual(SHADOW_MEASURE_CLASSES, [
    'user_judgement',
    'safety_outcome',
    'reliability_signal',
    'engagement',
  ]);
  assert.deepEqual(SHADOW_ENGAGEMENT_MEASURE_CLASSES, ['engagement']);
  assert.deepEqual(SHADOW_EVIDENCE_SUPPORTS, ['go', 'hold', 'rollback', 'inconclusive']);
  assert.deepEqual(SHADOW_RELEASE_DECISIONS, ['go', 'hold', 'rollback']);
  assert.deepEqual(SHADOW_REPLAY_PREIMAGE_SECTIONS, [
    'schema',
    'run',
    'controls',
    'exposure',
    'chain',
    'stage',
    'module',
    'outcome',
    'proposal',
  ]);
  assert.deepEqual(SHADOW_LOG_RECONCILIATION_FIELDS, [
    'runId',
    'module',
    'stagePosition',
    'bundleDigest',
    'occurredAt',
  ]);
  assert.deepEqual(SHADOW_PIPELINE_LIMIT_NAMES, [
    'maxProposedEffects',
    'maxTraceStages',
    'maxEvidenceItemsPerPillar',
    'maxSloReadingsPerPackage',
  ]);
});

test('the exposure reasons carry every pilot stop reason through unchanged', () => {
  // A second vocabulary saying `not_eligible` for all eight is how a support
  // conversation becomes unanswerable.
  for (const reason of SHADOW_PILOT_STOP_REASONS) {
    assert.ok(SHADOW_EXPOSURE_REASONS.includes(reason), `${reason} does not survive into the exposure vocabulary`);
  }
  assert.deepEqual(SHADOW_EXPOSURE_REASONS.slice(-4), [
    'stage_is_shadow_only',
    'stage_cap_exceeded',
    'study_consent_withheld',
    'study_consent_revoked',
  ]);
});

test('the invariants are a closed list and the engagement rule is Sprint 10 reused, not restated', () => {
  assert.deepEqual(SHADOW_PIPELINE_INVARIANTS, [
    'SHADOW_RESULT_CANNOT_MUTATE_CANONICAL_STATE',
    'EVERY_DECISION_HAS_A_TRACE_ENTRY',
    'TRACE_EXPLANATIONS_ARE_COHERENT',
    'DEGRADATION_IS_A_VARIANT_NOT_AN_ERROR_CODE',
    'FAIL_CLOSED_MODULES_WITHHOLD_RATHER_THAN_DEGRADE',
    'PLACEHOLDER_MODULES_NEVER_COMPLETE',
    'EVERY_BUDGET_IS_PER_MODULE_AND_REACHABLE',
    'REPLAY_DISAGREEMENT_IS_DETECTABLE_AND_LOCALISED',
    'NO_RAW_CONTENT_IN_TRACE_OR_OUTCOME',
    'ALERT_OWNERSHIP_IS_EXPLICIT',
    'SMALL_SAMPLES_ARE_INCONCLUSIVE_NOT_ZERO',
    'NO_GENERAL_RELEASE_IS_REPRESENTABLE',
    'CONSENT_IS_REVOCABLE_AND_REVOCATION_IS_STRUCTURAL',
    'DELETION_IS_VERIFIABLE',
    'DECISION_REQUIRES_QUALITY_SAFETY_AND_RELIABILITY',
    'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE',
  ]);
  assert.equal(SHADOW_RELEASE_GATE_INVARIANT, 'NO_RELEASE_GATE_ON_ENGAGEMENT_ALONE');
  assert.ok(
    PERSONALIZATION_INVARIANTS.includes(SHADOW_RELEASE_GATE_INVARIANT),
    'the release-gate invariant is not the one Sprint 10 owns',
  );
});

/* ── Tables: total, and pinned as values ─────────────────────────── */

test('budgets and limits are pinned as values, not only as identifiers', () => {
  // The Sprint 10 review lesson: probes below derive their sizes from these
  // constants, so the constants themselves must be held against literals or
  // every bound is mutable in both directions and no test notices.
  assert.deepEqual(SHADOW_MODULE_TIMEOUT_BUDGET_MS, {
    capture: 1_500,
    memory: 400,
    priority: 250,
    decomposition: 1_200,
    planning: 900,
    recommendation: 800,
    coaching: 1_500,
    safety: 600,
  });
  assert.equal(SHADOW_PIPELINE_TOTAL_BUDGET_MS, 8_000);
  assert.deepEqual(SHADOW_PIPELINE_LIMITS, {
    maxProposedEffects: 64,
    maxTraceStages: 32,
    maxEvidenceItemsPerPillar: 32,
    maxSloReadingsPerPackage: 64,
  });
  assert.equal(MIN_SLO_SAMPLE_COUNT, 20);
  assert.deepEqual(SHADOW_STAGE_PARTICIPANT_CAP, {
    shadow_only: 0,
    internal_dogfood: 10,
    closed_pilot: 40,
  });
  assert.deepEqual(SHADOW_STAGE_PARTICIPANT_FLOOR, {
    shadow_only: 0,
    internal_dogfood: 1,
    closed_pilot: 25,
  });
  assert.deepEqual(SHADOW_SLO_WINDOW_MILLIS, {
    rolling_1h: 3_600_000,
    rolling_24h: 86_400_000,
    rolling_7d: 604_800_000,
  });
});

test('the closed-pilot bounds are the shipped ones, restated and pinned', () => {
  assert.equal(SHADOW_STAGE_PARTICIPANT_CAP.closed_pilot, CLOSED_PILOT_MAXIMUM);
  assert.equal(SHADOW_STAGE_PARTICIPANT_FLOOR.closed_pilot, CLOSED_PILOT_MINIMUM);
});

test('the roles, stances, positions and contribution table are total over the chain', () => {
  for (const module of SHADOW_PIPELINE_CHAIN) {
    assert.ok(SHADOW_MODULE_ROLES[module] !== undefined, `${module} has no role`);
    assert.ok(SHADOW_MODULE_FAILURE_STANCE[module] !== undefined, `${module} has no failure stance`);
    assert.equal(typeof SHADOW_MODULE_TIMEOUT_BUDGET_MS[module], 'number');
    assert.equal(SHADOW_PIPELINE_CHAIN_POSITION[module], SHADOW_PIPELINE_CHAIN.indexOf(module));
  }
  assert.deepEqual(SHADOW_STATUS_CONTRIBUTION, {
    completed: true,
    fell_back: true,
    skipped: false,
    timed_out: false,
    unavailable: false,
  });
  // Exactly one fail-closed module, and it is the guard.
  assert.deepEqual(
    SHADOW_PIPELINE_CHAIN.filter((module) => SHADOW_MODULE_FAILURE_STANCE[module] === 'fail_closed'),
    ['safety'],
  );
  // Exactly one placeholder, and it is the module `moduleContracts` still stubs.
  assert.deepEqual(
    SHADOW_PIPELINE_CHAIN.filter((module) => SHADOW_MODULE_ROLES[module] === 'placeholder'),
    ['priority'],
  );
});

test('a completed stage admits no reason and every other status admits at least one', () => {
  assert.deepEqual(SHADOW_STAGE_REASON_ADMISSIBILITY.completed, []);
  for (const status of SHADOW_MODULE_STATUSES) {
    if (status === 'completed') continue;
    assert.ok(
      SHADOW_STAGE_REASON_ADMISSIBILITY[status].length > 0,
      `${status} has no admissible explanation, so it could never be explained`,
    );
    for (const reason of SHADOW_STAGE_REASON_ADMISSIBILITY[status]) {
      assert.ok(SHADOW_STAGE_REASONS.includes(reason), `${reason} is not in the reason vocabulary`);
    }
  }
});

/* ── Defect taxonomy ─────────────────────────────────────────────── */

test('the defect partitions are disjoint and their union is the whole taxonomy', () => {
  const partitions = Object.values(SHADOW_DEFECT_PARTITIONS);
  const seen = new Set<string>();
  let total = 0;
  for (const partition of partitions) {
    for (const code of partition) {
      assert.equal(seen.has(code), false, `${code} appears in more than one partition`);
      seen.add(code);
      total += 1;
    }
  }
  assert.equal(seen.size, total);
  assert.deepEqual(Object.keys(SHADOW_DEFECT_PARTITIONS), [
    'outcome',
    'trace',
    'replay',
    'slo',
    'reconciliation',
    'exposure',
    'receipt',
    'evidence',
    'configuration',
  ]);
  const listed =
    SHADOW_OUTCOME_DEFECT_CODES.length +
    SHADOW_TRACE_DEFECT_CODES.length +
    SHADOW_REPLAY_DEFECT_CODES.length +
    SHADOW_SLO_DEFECT_CODES.length +
    SHADOW_RECONCILIATION_DEFECT_CODES.length +
    SHADOW_EXPOSURE_DEFECT_CODES.length +
    SHADOW_RECEIPT_DEFECT_CODES.length +
    SHADOW_EVIDENCE_DEFECT_CODES.length +
    SHADOW_CONFIGURATION_DEFECT_CODES.length;
  assert.equal(listed, total);
});

/* ── The structural impossibilities ──────────────────────────────── */

test('a shadow outcome cannot carry anything callable: the type refuses it', () => {
  assert.equal(SHADOW_OUTCOME_INERTNESS, true);
  assert.equal(SHADOW_PROPOSAL_INERTNESS, true);

  // @ts-expect-error — a writer is not an inert value, at the top level.
  const withWriter: ShadowInertValue = { apply: () => undefined };
  // @ts-expect-error — nor at depth: the recursion is the mechanism.
  const nestedWriter: ShadowInertValue = { deliverable: { store: { commit: () => undefined } } };
  // @ts-expect-error — nor inside an array.
  const arrayWriter: ShadowInertValue = [{ write: () => undefined }];
  assert.equal(typeof withWriter, 'object');
  assert.equal(typeof nestedWriter, 'object');
  assert.equal(typeof arrayWriter, 'object');
});

test('a proposal has no apply method reachable from it, and no status that says applied', () => {
  const effect = proposal();
  // @ts-expect-error — a proposal carries no method; there is nothing to call.
  assert.equal(typeof effect.apply, 'undefined');
  // @ts-expect-error — `proposed_never_applied` is the only legal status.
  const applied: ShadowEffectProposal = { ...effect, status: 'applied' };
  assert.equal(applied.status, 'applied');
  assert.equal(effect.status, 'proposed_never_applied');
});

test('a complete outcome cannot carry a degradation and a withheld one cannot carry a deliverable', () => {
  const outcome = degradedOutcome();
  // @ts-expect-error — `complete` has `degradation: null` in the type.
  const wrongComplete: ShadowCompleteOutcome = { ...outcome, completeness: 'complete' };
  // @ts-expect-error — `withheld` has `deliverable: null` in the type.
  const wrongWithheld: ShadowWithheldOutcome = {
    ...outcome,
    completeness: 'withheld',
    withheldReason: 'chain_never_started',
  };
  assert.equal(wrongComplete.completeness, 'complete');
  assert.equal(wrongWithheld.completeness, 'withheld');
});

test('the module outcome record is total: a chain module cannot be omitted', () => {
  // @ts-expect-error — every module in the chain must have an outcome.
  const partial: ShadowCompleteOutcome['moduleOutcomes'] = { capture: moduleOutcome('capture') };
  assert.equal(Object.keys(partial).length, 1);
});

test('there is no general-availability stage to reach', () => {
  // #47's "no general release occurs in this issue", as a type rather than a
  // boolean somebody flips.
  // @ts-expect-error — the stage vocabulary is closed and has no such member.
  const generalRelease: ShadowExposureStage = 'general_availability';
  assert.equal(generalRelease, 'general_availability');
  assert.equal(SHADOW_EXPOSURE_POLICY.generalReleaseRepresentable, false);
  assert.equal(SHADOW_EXPOSURE_STAGES.includes('general_availability' as ShadowExposureStage), false);
});

test('a revoked consent cannot carry a scope, and an inconclusive reading cannot carry a value', () => {
  const revokedWithScope: ShadowRevokedConsent = {
    state: 'revoked',
    participantId: PARTICIPANT_ID,
    // @ts-expect-error — revocation leaves nothing to read: the tuple is empty.
    scopes: ['shadow_execution'],
    grantedAt: STARTED_AT,
    revokedAt: STARTED_AT,
  };
  // @ts-expect-error — an inconclusive reading carries `value: null`.
  const inconclusiveWithValue: ShadowSloReading = {
    status: 'inconclusive',
    sloId: 'x',
    value: 0,
    sampleCount: 1,
    breached: null,
    inconclusiveReason: 'insufficient_sample',
    windowStart: STARTED_AT,
    observedAt: STARTED_AT,
  };
  assert.equal(revokedWithScope.state, 'revoked');
  assert.equal(inconclusiveWithValue.status, 'inconclusive');
});

test('an evidence package cannot omit a pillar, and a pillar cannot be empty', () => {
  const complete = evidencePackage();
  const missingPillar: ShadowEvidencePackage = {
    ...complete,
    // @ts-expect-error — the evidence record is total over the three pillars.
    evidence: { quality: complete.evidence.quality, safety: complete.evidence.safety },
  };
  const emptyPillar: ShadowEvidencePackage = {
    ...complete,
    evidence: {
      ...complete.evidence,
      // @ts-expect-error — a pillar's bundle is a non-empty tuple.
      safety: [],
    },
  };
  assert.equal(Object.keys(missingPillar.evidence).length, 2);
  assert.equal(emptyPillar.evidence.safety.length, 0);
});

/* ── Inertness at the untyped boundary ───────────────────────────── */

test('a callable smuggled through an untyped boundary is reported at its path', () => {
  const outcome = degradedOutcome() as unknown as Record<string, unknown>;
  (outcome.deliverable as Record<string, unknown>).apply = () => undefined;
  const findings = checkShadowPipelineOutcome(outcome as unknown as ShadowPipelineOutcome);
  assert.ok(codesOf(findings).includes('OUTCOME_CARRIES_CALLABLE'));
  assert.ok(
    findings.some((finding) => finding.detail.includes('outcome.deliverable.apply')),
    'the finding does not locate the callable',
  );
});

test('the inertness walker survives a cycle rather than throwing', () => {
  // A checker that raises hands the decision to whichever caller forgot the
  // try/catch, and "so malformed the check crashed" must not read as "inert".
  const cyclic: Record<string, unknown> = { name: 'run' };
  cyclic.self = cyclic;
  assert.deepEqual(checkShadowInertness(cyclic), []);
  cyclic.writer = () => undefined;
  assert.deepEqual(codesOf(checkShadowInertness(cyclic)), ['OUTCOME_CARRIES_CALLABLE']);
});

test('the write surface names what this contract does not close', () => {
  assert.equal(SHADOW_WRITE_SURFACE.outcomeCarriesNoCallable, true);
  assert.equal(SHADOW_WRITE_SURFACE.proposalHasNoApplyMethod, true);
  assert.equal(SHADOW_WRITE_SURFACE.inputCarriesNoStoreHandle, true);
  // The honest half: a module's own entry point can still perform I/O, and the
  // enforcement for that lives in the implementation phase.
  assert.equal(SHADOW_WRITE_SURFACE.moduleAdapterMayReachIO, true);
  assert.match(SHADOW_WRITE_SURFACE.adapterEnforcement, /implementation-phase/);
});

/* ── The outcome checker ─────────────────────────────────────────── */

test('the realistic Sprint 11 run is clean, and it is degraded rather than complete', () => {
  const outcome = degradedOutcome();
  assert.deepEqual(checkShadowPipelineOutcome(outcome), []);
  assert.equal(outcome.completeness, 'degraded');
  assert.deepEqual(nonContributingModules(outcome), ['priority']);
  assert.deepEqual(contributingModules(outcome), [
    'capture',
    'memory',
    'decomposition',
    'planning',
    'recommendation',
    'coaching',
    'safety',
  ]);
});

test('a placeholder module claiming completion is reported, and so is the completion claim it enables', () => {
  const dishonest = tampered(degradedOutcome(), (draft) => {
    const outcomes = draft.moduleOutcomes as Record<string, Record<string, unknown>>;
    outcomes.priority = { ...outcomes.priority, status: 'completed', contributed: true, reason: null, outputDigest: DIGEST };
    draft.completeness = 'complete';
    draft.degradation = null;
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(dishonest)), ['PLACEHOLDER_MODULE_CLAIMS_COMPLETION']);
});

test('a complete outcome carrying a non-contributor is reported', () => {
  const overclaimed = tampered(degradedOutcome(), (draft) => {
    draft.completeness = 'complete';
    draft.degradation = null;
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(overclaimed)), ['COMPLETE_WITH_NON_CONTRIBUTOR']);
});

test('a status and a contribution flag that disagree are reported', () => {
  const lying = tampered(degradedOutcome(), (draft) => {
    const outcomes = draft.moduleOutcomes as Record<string, Record<string, unknown>>;
    outcomes.priority.contributed = true;
  });
  const findings = checkShadowPipelineOutcome(lying);
  assert.ok(codesOf(findings).includes('MODULE_CONTRIBUTION_DISAGREES_WITH_STATUS'));
  assert.equal(findings[0].module, 'priority');
});

test('a fail-closed module that did not contribute may not leave a deliverable', () => {
  const ungated = tampered(degradedOutcome(), (draft) => {
    const outcomes = draft.moduleOutcomes as Record<string, Record<string, unknown>>;
    outcomes.safety = {
      status: 'timed_out',
      module: 'safety',
      contributed: false,
      reason: 'budget_exhausted',
      failureCode: null,
      outputDigest: null,
      elapsedMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS.safety,
      budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS.safety,
    };
    (draft.degradation as Record<string, unknown>).nonContributingModules = ['priority', 'safety'];
    (draft.degradation as Record<string, unknown>).crossedFailClosedModule = true;
  });
  const findings = checkShadowPipelineOutcome(ungated);
  assert.deepEqual(codesOf(findings), ['FAIL_CLOSED_MODULE_DELIVERED_ANYWAY']);
  assert.equal(findings[0].module, 'safety');
});

test('withholding for a fail-closed module that in fact contributed is reported', () => {
  const wrongExcuse = tampered(degradedOutcome(), (draft) => {
    draft.completeness = 'withheld';
    draft.deliverable = null;
    draft.withheldReason = 'fail_closed_module_did_not_contribute';
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(wrongExcuse)), ['WITHHELD_WITHOUT_CAUSE']);
});

test('a degraded outcome that names no degraded module, or the wrong ones, is reported', () => {
  const empty = tampered(degradedOutcome(), (draft) => {
    (draft.degradation as Record<string, unknown>).nonContributingModules = [];
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(empty)), ['DEGRADED_WITHOUT_DEGRADATION']);

  const wrong = tampered(degradedOutcome(), (draft) => {
    (draft.degradation as Record<string, unknown>).nonContributingModules = ['planning'];
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(wrong)), ['DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES']);

  const wrongStance = tampered(degradedOutcome(), (draft) => {
    (draft.degradation as Record<string, unknown>).crossedFailClosedModule = true;
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(wrongStance)), [
    'DEGRADATION_DISAGREES_WITH_MODULE_OUTCOMES',
  ]);
});

test('a proposal that claims it was applied is reported: the type guarantee at the untyped boundary', () => {
  const applied = tampered(degradedOutcome(), (draft) => {
    const deliverable = draft.deliverable as Record<string, unknown>;
    (deliverable.proposedEffects as Record<string, unknown>[])[0].status = 'applied';
  });
  const findings = checkShadowPipelineOutcome(applied);
  assert.deepEqual(codesOf(findings), ['PROPOSAL_CLAIMS_APPLIED']);
  assert.equal(findings[0].proposalIndex, 0);
});

test('a proposal attributed to a module that did not contribute is reported', () => {
  const orphan = tampered(degradedOutcome(), (draft) => {
    const deliverable = draft.deliverable as Record<string, unknown>;
    (deliverable.proposedEffects as Record<string, unknown>[])[0].proposedBy = 'priority';
  });
  const findings = checkShadowPipelineOutcome(orphan);
  assert.deepEqual(codesOf(findings), ['PROPOSAL_FROM_NON_CONTRIBUTING_MODULE']);
  assert.equal(findings[0].module, 'priority');
});

test('digests are hex, present when there is output and absent when there is not', () => {
  const blank = tampered(degradedOutcome(), (draft) => {
    (draft.moduleOutcomes as Record<string, Record<string, unknown>>).planning.outputDigest = '   ';
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(blank)), ['MODULE_DIGEST_MISSING']);

  // Prose in a digest field is a different bug from an empty one, and it is the
  // one that can carry content.
  const prose = tampered(degradedOutcome(), (draft) => {
    (draft.moduleOutcomes as Record<string, Record<string, unknown>>).planning.outputDigest =
      'call-dr-cohen-about-the-biopsy';
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(prose)), ['MODULE_DIGEST_MALFORMED']);

  const spurious = tampered(degradedOutcome(), (draft) => {
    (draft.moduleOutcomes as Record<string, Record<string, unknown>>).priority.outputDigest = DIGEST;
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(spurious)), [
    'MODULE_DIGEST_PRESENT_WITHOUT_CONTRIBUTION',
  ]);
});

test('an unsupported schema version suppresses every other claim about the shape', () => {
  const foreign = tampered(degradedOutcome(), (draft) => {
    draft.schemaVersion = 'shadow-pipeline-v2';
    draft.runId = 'NOT A SAFE CODE';
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(foreign)), ['OUTCOME_VERSION_UNSUPPORTED']);
});

test('an unsafe run identifier is reported, because the preimage joins on control characters', () => {
  const forged = tampered(degradedOutcome(), (draft) => {
    draft.runId = `run${String.fromCharCode(0x1f)}forged`;
  });
  assert.ok(codesOf(checkShadowPipelineOutcome(forged)).includes('RUN_ID_UNSAFE'));
  assert.equal(SHADOW_SAFE_CODE.test(`run${String.fromCharCode(0x1f)}forged`), false);
});

test('every limit in the table is reachable, and each finding names the key it broke', () => {
  const reached = new Set<string>();

  const tooManyProposals = tampered(degradedOutcome(), (draft) => {
    const deliverable = draft.deliverable as Record<string, unknown>;
    // Size derived from the constant, not from a literal.
    deliverable.proposedEffects = Array.from(
      { length: SHADOW_PIPELINE_LIMITS.maxProposedEffects + 1 },
      () => proposal(),
    );
  });
  for (const finding of checkShadowPipelineOutcome(tooManyProposals)) {
    if (finding.limitName !== null) reached.add(finding.limitName);
  }

  const outcome = degradedOutcome();
  const longTrace = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as unknown[];
    draft.stages = Array.from(
      { length: SHADOW_PIPELINE_LIMITS.maxTraceStages + 1 },
      (_unused, index) => stages[index % stages.length],
    );
  });
  for (const finding of checkShadowTrace(longTrace, outcome)) {
    if (finding.limitName !== null) reached.add(finding.limitName);
  }

  const fatPillar = tampered(evidencePackage(), (draft) => {
    const evidence = draft.evidence as Record<string, unknown[]>;
    const item = evidence.quality[0];
    evidence.quality = Array.from(
      { length: SHADOW_PIPELINE_LIMITS.maxEvidenceItemsPerPillar + 1 },
      () => item,
    );
  });
  for (const finding of checkShadowEvidencePackage(fatPillar)) {
    if (finding.limitName !== null) reached.add(finding.limitName);
  }

  const manyReadings = tampered(evidencePackage(), (draft) => {
    const evidence = draft.evidence as Record<string, unknown[]>;
    const item = { ...(evidence.reliability[0] as Record<string, unknown>) };
    const perPillar = Math.ceil(
      (SHADOW_PIPELINE_LIMITS.maxSloReadingsPerPackage + 1) / SHADOW_EVIDENCE_PILLARS.length,
    );
    for (const pillar of SHADOW_EVIDENCE_PILLARS) {
      evidence[pillar] = Array.from({ length: perPillar }, () => ({ ...item, pillar }));
    }
  });
  for (const finding of checkShadowEvidencePackage(manyReadings)) {
    if (finding.limitName !== null) reached.add(finding.limitName);
  }

  assert.deepEqual(
    SHADOW_PIPELINE_LIMIT_NAMES.filter((name) => !reached.has(name)),
    [],
    'a limit exists that no test can name; that is documentation of an intention',
  );
});

test('a run that outlives the declared ceiling without saying so is reported', () => {
  const slow = tampered(degradedOutcome(), (draft) => {
    draft.totalElapsedMs = SHADOW_PIPELINE_TOTAL_BUDGET_MS + 1;
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(slow)), ['TOTAL_ELAPSED_EXCEEDS_TOTAL_BUDGET']);
});

/* ── The trace: every downstream decision explained ──────────────── */

test('a trace over the clean run reports nothing', () => {
  const outcome = degradedOutcome();
  assert.deepEqual(checkShadowTrace(traceFor(outcome), outcome), []);
});

test('a chain module with no stage is reported: the outcome decides and nothing explains', () => {
  const outcome = degradedOutcome();
  const missing = tampered(traceFor(outcome), (draft) => {
    draft.stages = (draft.stages as Record<string, unknown>[]).filter(
      (stage) => stage.module !== 'planning',
    );
  });
  const findings = checkShadowTrace(missing, outcome);
  // Both findings are the point, not noise: the deleted stage is the one that
  // proposed the effect, so the outcome now carries a proposal nothing accounts
  // for either. Neither suppresses the other — they are two decisions with two
  // missing explanations.
  assert.deepEqual(codesOf(findings), ['TRACE_STAGE_MISSING', 'TRACE_PROPOSAL_UNEXPLAINED']);
  assert.equal(findings[0].module, 'planning');
  assert.equal(findings[0].stagePosition, SHADOW_PIPELINE_CHAIN_POSITION.planning);
  assert.equal(findings[1].proposalIndex, 0);
});

test('a stage that did not complete and states no reason is reported', () => {
  const outcome = degradedOutcome();
  const silent = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    const stage = stages.find((candidate) => candidate.module === 'priority');
    if (stage !== undefined) stage.reason = null;
  });
  const findings = checkShadowTrace(silent, outcome);
  assert.deepEqual(codesOf(findings), ['TRACE_REASON_MISSING']);
  assert.equal(findings[0].module, 'priority');
});

test('a reason that cannot produce its status is reported', () => {
  const outcome = degradedOutcome();
  const incoherent = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    const stage = stages.find((candidate) => candidate.module === 'priority');
    if (stage !== undefined) {
      stage.status = 'timed_out';
      stage.reason = 'feature_disabled';
    }
  });
  const codes = codesOf(checkShadowTrace(incoherent, outcome));
  assert.ok(codes.includes('TRACE_REASON_NOT_ADMISSIBLE_FOR_STATUS'));
  assert.ok(codes.includes('TRACE_STAGE_STATUS_MISMATCH'));
});

test('a completed stage that also excuses itself is reported', () => {
  const outcome = degradedOutcome();
  const excused = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    const stage = stages.find((candidate) => candidate.module === 'planning');
    if (stage !== undefined) stage.reason = 'module_error';
  });
  assert.deepEqual(codesOf(checkShadowTrace(excused, outcome)), [
    'TRACE_COMPLETED_STAGE_STATES_REASON',
  ]);
});

test('a stage blaming a switch its own runtime decision says was not thrown is reported', () => {
  const outcome = degradedOutcome();
  const narrated = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    const stage = stages.find((candidate) => candidate.module === 'priority');
    if (stage !== undefined) {
      stage.status = 'skipped';
      stage.reason = 'kill_switch_active';
    }
  });
  const codes = codesOf(checkShadowTrace(narrated, outcome));
  assert.ok(codes.includes('TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION'));
});

test('a proposal no stage accounts for is reported, and so is one claimed by the wrong stage', () => {
  const outcome = degradedOutcome();
  const unexplained = tampered(traceFor(outcome), (draft) => {
    for (const stage of draft.stages as Record<string, unknown>[]) stage.proposalIndices = [];
  });
  const findings = checkShadowTrace(unexplained, outcome);
  assert.deepEqual(codesOf(findings), ['TRACE_PROPOSAL_UNEXPLAINED']);
  assert.equal(findings[0].proposalIndex, 0);

  const misattributed = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    for (const stage of stages) stage.proposalIndices = [];
    const coaching = stages.find((candidate) => candidate.module === 'coaching');
    if (coaching !== undefined) coaching.proposalIndices = [0];
  });
  assert.deepEqual(codesOf(checkShadowTrace(misattributed, outcome)), [
    'TRACE_PROPOSAL_ATTRIBUTION_MISMATCH',
  ]);

  const outOfRange = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    const planning = stages.find((candidate) => candidate.module === 'planning');
    if (planning !== undefined) planning.proposalIndices = [0, 7];
  });
  assert.deepEqual(codesOf(checkShadowTrace(outOfRange, outcome)), [
    'TRACE_PROPOSAL_INDEX_OUT_OF_RANGE',
  ]);
});

test('every module budget is reachable from both sides, with the probe derived from the constant', () => {
  const outcome = degradedOutcome();
  const overrun = new Set<string>();
  const early = new Set<string>();

  for (const module of SHADOW_PIPELINE_CHAIN) {
    const budget = SHADOW_MODULE_TIMEOUT_BUDGET_MS[module];

    const past = tampered(traceFor(outcome), (draft) => {
      const stage = (draft.stages as Record<string, unknown>[]).find(
        (candidate) => candidate.module === module,
      );
      if (stage === undefined) return;
      stage.status = 'completed';
      stage.reason = null;
      stage.outputDigest = DIGEST;
      stage.elapsedMs = budget + 1;
      stage.endedAt = new Date(Date.parse(stage.startedAt as string) + budget + 1).toISOString();
    });
    if (codesOf(checkShadowTrace(past, outcome)).includes('TRACE_COMPLETED_EXCEEDS_BUDGET')) {
      overrun.add(module);
    }

    const impatient = tampered(traceFor(outcome), (draft) => {
      const stage = (draft.stages as Record<string, unknown>[]).find(
        (candidate) => candidate.module === module,
      );
      if (stage === undefined) return;
      stage.status = 'timed_out';
      stage.reason = 'budget_exhausted';
      stage.outputDigest = null;
      stage.elapsedMs = budget - 1;
      stage.endedAt = new Date(Date.parse(stage.startedAt as string) + budget - 1).toISOString();
    });
    if (codesOf(checkShadowTrace(impatient, outcome)).includes('TRACE_TIMEOUT_WITHIN_BUDGET')) {
      early.add(module);
    }
  }

  assert.deepEqual([...SHADOW_PIPELINE_CHAIN].filter((module) => !overrun.has(module)), []);
  assert.deepEqual([...SHADOW_PIPELINE_CHAIN].filter((module) => !early.has(module)), []);
});

test('a stage judged against an undeclared budget is reported', () => {
  const outcome = degradedOutcome();
  const invented = tampered(traceFor(outcome), (draft) => {
    const stage = (draft.stages as Record<string, unknown>[])[0];
    stage.budgetMs = 999_999;
  });
  assert.deepEqual(codesOf(checkShadowTrace(invented, outcome)), ['TRACE_BUDGET_NOT_DECLARED']);
});

test('a carried duration that disagrees with the stage instants is reported', () => {
  // The reason `elapsedMs` is carried rather than derived: a recomputed
  // duration can never disagree, and therefore can never show a clock jump.
  const outcome = degradedOutcome();
  const skewed = tampered(traceFor(outcome), (draft) => {
    const stage = (draft.stages as Record<string, unknown>[])[0];
    stage.endedAt = new Date(Date.parse(stage.startedAt as string) + 12).toISOString();
  });
  assert.deepEqual(codesOf(checkShadowTrace(skewed, outcome)), [
    'TRACE_ELAPSED_DISAGREES_WITH_INTERVAL',
  ]);

  // Suppression: the duration judgements borrow their bound from the interval.
  const unparseable = tampered(traceFor(outcome), (draft) => {
    const stage = (draft.stages as Record<string, unknown>[])[0];
    stage.endedAt = 'not-a-time';
  });
  const codes = codesOf(checkShadowTrace(unparseable, outcome));
  assert.ok(codes.includes('TRACE_INTERVAL_INVALID'));
  assert.equal(codes.includes('TRACE_ELAPSED_DISAGREES_WITH_INTERVAL'), false);
});

test('a trace out of chain order, duplicated, or about another run is reported', () => {
  const outcome = degradedOutcome();
  const reordered = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    draft.stages = [stages[1], stages[0], ...stages.slice(2)];
  });
  assert.deepEqual(codesOf(checkShadowTrace(reordered, outcome)), ['TRACE_STAGE_OUT_OF_ORDER']);

  const doubled = tampered(traceFor(outcome), (draft) => {
    const stages = draft.stages as Record<string, unknown>[];
    draft.stages = [...stages, stages[stages.length - 1]];
  });
  assert.deepEqual(codesOf(checkShadowTrace(doubled, outcome)), ['TRACE_STAGE_DUPLICATED']);

  const foreign = tampered(traceFor(outcome), (draft) => {
    draft.runId = 'run-someone-else';
  });
  assert.deepEqual(codesOf(checkShadowTrace(foreign, outcome)), ['TRACE_RUN_ID_MISMATCH']);
});

/* ── Replay ──────────────────────────────────────────────────────── */

test('the preimage is deterministic and independent of key insertion order', () => {
  const bundle = bundleFor(degradedOutcome());
  assert.equal(shadowReplayPreimage(bundle), shadowReplayPreimage(bundle));

  // Same data, keys inserted in the reverse order: a `JSON.stringify` preimage
  // would differ here and a positional one must not.
  const rebuilt: ShadowReplayBundle = {
    bundleDigest: bundle.bundleDigest,
    outcome: bundle.outcome,
    trace: bundle.trace,
    input: bundle.input,
    recordedAt: bundle.recordedAt,
    runId: bundle.runId,
    schemaVersion: bundle.schemaVersion,
    version: bundle.version,
  };
  assert.equal(shadowReplayPreimage(rebuilt), shadowReplayPreimage(bundle));
});

test('a null field and the string "null" do not serialise the same way', () => {
  const bundle = bundleFor(degradedOutcome());
  const spoofed = tampered(bundle, (draft) => {
    (draft.input as Record<string, unknown>).alphaSessionId = 'null';
  });
  assert.notEqual(shadowReplayPreimage(spoofed), shadowReplayPreimage(bundle));
});

test('an identical replay reports nothing', () => {
  const bundle = bundleFor(degradedOutcome());
  assert.deepEqual(checkShadowReplay(bundle, observationFor(bundle)), []);
});

test('a divergent replay is localised to the module that moved', () => {
  const bundle = bundleFor(degradedOutcome());
  const replayed = tampered(observationFor(bundle), (draft) => {
    const outcomes = (draft.outcome as Record<string, Record<string, Record<string, unknown>>>)
      .moduleOutcomes;
    outcomes.planning.status = 'timed_out';
  });
  const findings = checkShadowReplay(bundle, replayed);
  const codes = codesOf(findings);
  assert.ok(codes.includes('REPLAY_MODULE_STATUS_DIVERGED'));
  assert.ok(codes.includes('REPLAY_PREIMAGE_DIVERGED'));
  const localised = findings.find((finding) => finding.code === 'REPLAY_MODULE_STATUS_DIVERGED');
  assert.equal(localised?.module, 'planning');
  assert.equal(localised?.stagePosition, SHADOW_PIPELINE_CHAIN_POSITION.planning);
});

test('a flag that moved between the runs is named as such, not as an unexplained divergence', () => {
  const bundle = bundleFor(degradedOutcome());
  const replayed = tampered(observationFor(bundle), (draft) => {
    const runtime = draft.controls as Record<string, Record<string, boolean>>;
    runtime.killSwitches.coaching = true;
  });
  const codes = codesOf(checkShadowReplay(bundle, replayed));
  assert.ok(codes.includes('REPLAY_CONTROLS_DIVERGED'));
});

test('equal preimages with unequal digests is a hashing change, reported separately', () => {
  const bundle = bundleFor(degradedOutcome());
  const replayed: ShadowReplayObservation = { ...observationFor(bundle), bundleDigest: OTHER_DIGEST };
  const codes = codesOf(checkShadowReplay(bundle, replayed));
  assert.deepEqual(codes, ['REPLAY_DIGEST_DIVERGED']);
  assert.equal(codes.includes('REPLAY_PREIMAGE_DIVERGED'), false);
});

test('a shadow-only run may not claim it would have been shown, or carry a session', () => {
  const bundle = bundleFor(degradedOutcome());
  const exposed = tampered(bundle, (draft) => {
    ((draft.outcome as Record<string, unknown>).deliverable as Record<string, unknown>)
      .wouldHaveBeenShown = true;
    (draft.trace as Record<string, unknown>).alphaSessionId = 'session-1';
  });
  const codes = codesOf(checkShadowReplay(exposed, observationFor(exposed)));
  assert.ok(codes.includes('DELIVERABLE_CLAIMS_EXPOSURE_AT_SHADOW_ONLY'));
  assert.ok(codes.includes('ALPHA_SESSION_AT_SHADOW_ONLY'));
});

/* ── The alphaTrace seam ─────────────────────────────────────────── */

test('the alpha trace relationship is a recorded decision, not an inherited overlap', () => {
  assert.deepEqual(SHADOW_TRACE_ALPHA_SEAM, {
    relationship: 'separate_systems_one_field_seam',
    shadowField: 'alphaSessionId',
    alphaField: 'sessionId',
    payloadCrossesSeam: false,
    shadowTraceCarriesRawContent: false,
    nullAtShadowOnly: true,
  });
  // The two systems version independently; the seam is one field, not a merge.
  assert.equal(ALPHA_TRACE_VERSION, 'alpha-trace-v1');
  assert.notEqual(ALPHA_TRACE_VERSION, SHADOW_PIPELINE_SCHEMA_VERSION);
  const trace = traceFor(degradedOutcome());
  assert.deepEqual(Object.keys(trace).filter((key) => key.startsWith('alpha')), ['alphaSessionId']);
});

/* ── SLOs (#46) ──────────────────────────────────────────────────── */

test('a well-formed SLO definition reports nothing, and every owner failure is reachable', () => {
  assert.deepEqual(checkShadowSloDefinition(sloDefinition()), []);

  const ownerless = tampered(sloDefinition(), (draft) => {
    draft.owner = null;
  });
  assert.deepEqual(codesOf(checkShadowSloDefinition(ownerless)), ['SLO_OWNER_MISSING']);

  const unroutable = tampered(sloDefinition(), (draft) => {
    (draft.owner as Record<string, unknown>).rotationId = 'the team';
  });
  assert.deepEqual(codesOf(checkShadowSloDefinition(unroutable)), ['SLO_OWNER_ROTATION_UNSAFE']);

  const circular = tampered(sloDefinition(), (draft) => {
    (draft.owner as Record<string, unknown>).escalationRotationId = 'quality-primary';
  });
  assert.deepEqual(codesOf(checkShadowSloDefinition(circular)), ['SLO_ESCALATION_SAME_AS_PRIMARY']);

  const unknownTeam = tampered(sloDefinition(), (draft) => {
    (draft.owner as Record<string, unknown>).team = 'platform';
  });
  assert.deepEqual(codesOf(checkShadowSloDefinition(unknownTeam)), ['SLO_OWNER_TEAM_UNKNOWN']);
});

test('the sample floor under the floor is reachable from below', () => {
  const permissive = tampered(sloDefinition(), (draft) => {
    draft.minimumSampleCount = MIN_SLO_SAMPLE_COUNT - 1;
  });
  assert.deepEqual(codesOf(checkShadowSloDefinition(permissive)), ['SLO_SAMPLE_FLOOR_TOO_LOW']);
});

test('a small sample is a variant, not a number: a measured reading below the floor is reported', () => {
  const definition = sloDefinition();
  assert.deepEqual(checkShadowSloReading(measuredReading(), definition), []);

  const thin = measuredReading({ sampleCount: definition.minimumSampleCount - 1 });
  assert.deepEqual(codesOf(checkShadowSloReading(thin, definition)), [
    'SLO_MEASURED_BELOW_SAMPLE_FLOOR',
  ]);

  const inconclusive: ShadowSloReading = {
    status: 'inconclusive',
    sloId: definition.sloId,
    value: null,
    sampleCount: definition.minimumSampleCount - 1,
    breached: null,
    inconclusiveReason: 'insufficient_sample',
    windowStart: instantAfter(-SHADOW_SLO_WINDOW_MILLIS.rolling_24h),
    observedAt: STARTED_AT,
  };
  assert.deepEqual(checkShadowSloReading(inconclusive, definition), []);
});

test('an unreadable measurement is its own code, because NaN comparisons fail open', () => {
  const definition = sloDefinition();
  const broken = measuredReading({ value: Number.NaN });
  assert.deepEqual(codesOf(checkShadowSloReading(broken, definition)), ['SLO_VALUE_NOT_FINITE']);
  assert.equal(shadowSloBreached(definition, Number.NaN), null);
});

test('a breach flag that disagrees with the comparison is reported, in both directions', () => {
  const definition = sloDefinition();
  const understated = measuredReading({ value: definition.threshold + 1, breached: false });
  assert.deepEqual(codesOf(checkShadowSloReading(understated, definition)), [
    'SLO_BREACH_DISAGREES_WITH_THRESHOLD',
  ]);

  const atLeast: ShadowSloDefinition = {
    ...definition,
    sloId: 'trace-completeness',
    metric: 'trace_completeness_rate',
    comparison: 'at_least',
    threshold: 0.99,
  };
  assert.equal(shadowSloBreached(atLeast, 0.98), true);
  assert.equal(shadowSloBreached(atLeast, 1), false);
});

test('an inconclusive reading that carries a value is reported', () => {
  const definition = sloDefinition();
  const decided = tampered(
    {
      status: 'inconclusive',
      sloId: definition.sloId,
      value: null,
      sampleCount: 3,
      breached: null,
      inconclusiveReason: 'insufficient_sample',
      windowStart: instantAfter(-SHADOW_SLO_WINDOW_MILLIS.rolling_24h),
      observedAt: STARTED_AT,
    } as ShadowSloReading,
    (draft) => {
      draft.value = 0;
    },
  );
  assert.deepEqual(codesOf(checkShadowSloReading(decided, definition)), [
    'SLO_INCONCLUSIVE_NOT_VALUE_FREE',
  ]);
});

test('a reading whose window is not the window its definition declares is reported', () => {
  const definition = sloDefinition();
  const wrongWindow = measuredReading({
    windowStart: instantAfter(-SHADOW_SLO_WINDOW_MILLIS.rolling_1h),
  });
  assert.deepEqual(codesOf(checkShadowSloReading(wrongWindow, definition)), [
    'SLO_READING_WINDOW_INCOHERENT',
  ]);
});

/* ── Privacy-safe log reconciliation (#46) ───────────────────────── */

test('the forbidden log key classes are the shipped analytics validator list, enforced by it', () => {
  // The strong pin: each class is driven through the shipped
  // `validateAnalyticsEvent`, so a class added there and not here fails.
  for (const forbidden of SHADOW_FORBIDDEN_LOG_KEY_CLASSES) {
    const property = `${forbidden}Field`;
    const result = validateAnalyticsEvent({
      version: ANALYTICS_EVENT_CONTRACT_VERSION,
      eventId: 'event-1',
      eventName: 'capture_submitted',
      occurredAt: STARTED_AT,
      anonymousUserId: 'user-1',
      cohortId: 'cohort-1',
      experiment: null,
      consent: 'granted',
      properties: { [property]: 'x' },
    });
    assert.ok(
      result.errors.includes(`private property is forbidden: ${property}`),
      `the shipped validator does not forbid the "${forbidden}" class this contract lists`,
    );
  }
});

test('a reconciling log line reports nothing, and a leak is caught by name', () => {
  const bundle = bundleFor(degradedOutcome());
  const clean = {
    runId: bundle.runId,
    module: 'planning',
    stagePosition: SHADOW_PIPELINE_CHAIN_POSITION.planning,
    bundleDigest: bundle.bundleDigest,
    occurredAt: STARTED_AT,
  };
  assert.deepEqual(checkShadowLogReconciliation(clean, bundle.trace, bundle.bundleDigest), []);

  const leaky = { ...clean, commitmentTitle: 'call dr cohen about the biopsy' };
  assert.deepEqual(
    codesOf(checkShadowLogReconciliation(leaky, bundle.trace, bundle.bundleDigest)),
    ['LOG_CARRIES_FORBIDDEN_KEY'],
  );
});

test('a half-located log line is reported rather than counted as reconciled', () => {
  const bundle = bundleFor(degradedOutcome());
  const half = {
    runId: bundle.runId,
    module: 'planning',
    stagePosition: null,
    bundleDigest: bundle.bundleDigest,
    occurredAt: STARTED_AT,
  };
  assert.deepEqual(
    codesOf(checkShadowLogReconciliation(half, bundle.trace, bundle.bundleDigest)),
    ['LOG_STAGE_LOCATOR_INCOHERENT'],
  );

  const pipelineLevel = { ...half, module: null };
  assert.deepEqual(
    checkShadowLogReconciliation(pipelineLevel, bundle.trace, bundle.bundleDigest),
    [],
  );
});

test('a log line about a stage the trace does not have is reported, and so is a digest mismatch', () => {
  const bundle = bundleFor(degradedOutcome());
  const truncated = tampered(bundle.trace, (draft) => {
    draft.stages = (draft.stages as Record<string, unknown>[]).filter(
      (stage) => stage.module !== 'planning',
    );
  });
  const line = {
    runId: bundle.runId,
    module: 'planning',
    stagePosition: SHADOW_PIPELINE_CHAIN_POSITION.planning,
    bundleDigest: bundle.bundleDigest,
    occurredAt: STARTED_AT,
  };
  const findings = checkShadowLogReconciliation(line, truncated, bundle.bundleDigest);
  assert.deepEqual(codesOf(findings), ['LOG_STAGE_NOT_IN_TRACE']);
  assert.equal(findings[0].module, 'planning');

  assert.deepEqual(
    codesOf(checkShadowLogReconciliation(line, bundle.trace, OTHER_DIGEST)),
    ['LOG_DIGEST_MISMATCH'],
  );
});

/* ── Staged exposure and consent (#47) ───────────────────────────── */

test('the shadow gate can only narrow the pilot gate: every stop reason survives', () => {
  for (const reason of SHADOW_PILOT_STOP_REASONS) {
    const decision = resolveShadowExposure({
      participantId: PARTICIPANT_ID,
      stage: 'closed_pilot',
      cohortSize: CLOSED_PILOT_MINIMUM,
      pilotDecision: { allowed: false, reason },
      consent: grantedConsent(),
    });
    assert.equal(decision.allowed, false, `${reason} was widened by the shadow gate`);
    assert.equal(decision.reason, reason);
  }
  assert.equal(SHADOW_EXPOSURE_POLICY.shadowExposureNeverExceedsPilot, true);
});

test('nobody is exposed at shadow_only, whatever they consented to', () => {
  const decision = resolveShadowExposure({
    participantId: PARTICIPANT_ID,
    stage: 'shadow_only',
    cohortSize: 0,
    pilotDecision: { allowed: true, reason: 'authorized' },
    consent: grantedConsent(),
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'stage_is_shadow_only');
  assert.equal(decision.cap, 0);
  assert.equal(SHADOW_EXPOSURE_POLICY.shadowOnlyExposesNobody, true);
});

test('a withdrawn consent is told it was withdrawn, not that the cohort was full', () => {
  const revoked: ShadowStudyConsent = {
    state: 'revoked',
    participantId: PARTICIPANT_ID,
    scopes: [],
    grantedAt: STARTED_AT,
    revokedAt: instantAfter(60_000),
  };
  const decision = resolveShadowExposure({
    participantId: PARTICIPANT_ID,
    stage: 'closed_pilot',
    cohortSize: CLOSED_PILOT_MAXIMUM + 1,
    pilotDecision: { allowed: true, reason: 'authorized' },
    consent: revoked,
  });
  assert.equal(decision.reason, 'study_consent_revoked');
});

test('a granted consent inside the cap is authorized, and one past it is capped', () => {
  const inside = resolveShadowExposure({
    participantId: PARTICIPANT_ID,
    stage: 'closed_pilot',
    cohortSize: SHADOW_STAGE_PARTICIPANT_CAP.closed_pilot,
    pilotDecision: { allowed: true, reason: 'authorized' },
    consent: grantedConsent(),
  });
  assert.equal(inside.allowed, true);
  assert.equal(inside.reason, 'authorized');
  assert.deepEqual(checkShadowExposureDecision(inside, { allowed: true, reason: 'authorized' }), []);

  const past = resolveShadowExposure({
    participantId: PARTICIPANT_ID,
    stage: 'closed_pilot',
    cohortSize: SHADOW_STAGE_PARTICIPANT_CAP.closed_pilot + 1,
    pilotDecision: { allowed: true, reason: 'authorized' },
    consent: grantedConsent(),
  });
  assert.equal(past.allowed, false);
  assert.equal(past.reason, 'stage_cap_exceeded');
});

test('a consent granting no shadow-execution scope does not authorize execution', () => {
  const narrow: ShadowStudyConsent = {
    state: 'granted',
    participantId: PARTICIPANT_ID,
    scopes: ['feedback_study'],
    grantedAt: STARTED_AT,
    revokedAt: null,
  };
  const decision = resolveShadowExposure({
    participantId: PARTICIPANT_ID,
    stage: 'internal_dogfood',
    cohortSize: 4,
    pilotDecision: { allowed: true, reason: 'authorized' },
    consent: narrow,
  });
  assert.equal(decision.reason, 'study_consent_withheld');
});

test('the exposure checker catches a decision that widened the pilot gate', () => {
  const forged = tampered(
    resolveShadowExposure({
      participantId: PARTICIPANT_ID,
      stage: 'closed_pilot',
      cohortSize: CLOSED_PILOT_MINIMUM,
      pilotDecision: { allowed: true, reason: 'authorized' },
      consent: grantedConsent(),
    }),
    () => undefined,
  );
  assert.deepEqual(
    codesOf(checkShadowExposureDecision(forged, { allowed: false, reason: 'revoked' })),
    ['EXPOSURE_ALLOWED_WITH_STOP_REASON'],
  );
});

test('a closed pilot too small to decide on is reported', () => {
  const thin = tampered(
    resolveShadowExposure({
      participantId: PARTICIPANT_ID,
      stage: 'closed_pilot',
      cohortSize: CLOSED_PILOT_MINIMUM,
      pilotDecision: { allowed: true, reason: 'authorized' },
      consent: grantedConsent(),
    }),
    (draft) => {
      draft.cohortSize = CLOSED_PILOT_MINIMUM - 1;
    },
  );
  assert.deepEqual(
    codesOf(checkShadowExposureDecision(thin, { allowed: true, reason: 'authorized' })),
    ['EXPOSURE_COHORT_BELOW_STAGE_FLOOR'],
  );
});

test('revocation is structural, and the checker covers the untyped boundary', () => {
  assert.deepEqual(checkShadowStudyConsent(grantedConsent()), []);

  const zombie = tampered(
    {
      state: 'revoked',
      participantId: PARTICIPANT_ID,
      scopes: [],
      grantedAt: STARTED_AT,
      revokedAt: instantAfter(1_000),
    } as ShadowStudyConsent,
    (draft) => {
      draft.scopes = ['shadow_execution'];
    },
  );
  assert.deepEqual(codesOf(checkShadowStudyConsent(zombie)), ['CONSENT_INACTIVE_CARRIES_SCOPES']);

  const backwards = tampered(
    {
      state: 'revoked',
      participantId: PARTICIPANT_ID,
      scopes: [],
      grantedAt: instantAfter(1_000),
      revokedAt: STARTED_AT,
    } as ShadowStudyConsent,
    () => undefined,
  );
  assert.deepEqual(codesOf(checkShadowStudyConsent(backwards)), ['CONSENT_REVOKED_BEFORE_GRANTED']);

  const empty = tampered(grantedConsent(), (draft) => {
    draft.scopes = [];
  });
  assert.deepEqual(codesOf(checkShadowStudyConsent(empty)), ['CONSENT_GRANTED_WITHOUT_SCOPES']);
  assert.equal(SHADOW_EXPOSURE_POLICY.revocationIsStructural, true);
  assert.equal(SHADOW_EXPOSURE_POLICY.defaultConsentState, 'withheld');
});

/* ── Deletion (#47), reusing Sprint 10 rather than restating it ──── */

test('a clean study deletion receipt reports nothing', () => {
  assert.deepEqual(checkShadowStudyDeletionReceipt(deletionReceipt()), []);
});

test('a remainder that is not zero, and one that is not a count, are different codes', () => {
  const leftovers = tampered(deletionReceipt(), (draft) => {
    draft.remainingTraceCount = 3;
  });
  assert.deepEqual(codesOf(checkShadowStudyDeletionReceipt(leftovers)), [
    'SHADOW_RECEIPT_REMAINDER_NOT_ZERO',
  ]);

  // `NaN > 0` is false, so folding these would make an unreadable receipt pass.
  const unreadable = tampered(deletionReceipt(), (draft) => {
    draft.remainingReplayBundleCount = 'none';
  });
  assert.deepEqual(codesOf(checkShadowStudyDeletionReceipt(unreadable)), [
    'SHADOW_RECEIPT_REMAINDER_NOT_A_COUNT',
  ]);
});

test('a defect in the embedded personalization receipt surfaces through the outer checker', () => {
  const nested = tampered(deletionReceipt(), (draft) => {
    (draft.personalization as Record<string, unknown>).remainingFeedbackEventCount = 2;
  });
  const findings = checkShadowStudyDeletionReceipt(nested);
  assert.deepEqual(codesOf(findings), ['SHADOW_NESTED_RECEIPT_DEFECT']);
  // The inner code travels in the detail: one vocabulary, extended.
  assert.match(findings[0].detail, /RECEIPT_REMAINDER_NOT_ZERO/);
});

/* ── The evidence package (#47) ──────────────────────────────────── */

test('a hold package with all three pillars reports nothing, and so does a well-supported go', () => {
  assert.deepEqual(checkShadowEvidencePackage(evidencePackage('hold')), []);
  assert.deepEqual(checkShadowEvidencePackage(evidencePackage('go')), []);
});

test('a go resting on engagement alone is reported, per the Sprint 10 invariant', () => {
  const engagementOnly = tampered(evidencePackage('go'), (draft) => {
    const evidence = draft.evidence as Record<string, Record<string, unknown>[]>;
    evidence.quality[0].measureClass = 'engagement';
  });
  const findings = checkShadowEvidencePackage(engagementOnly);
  assert.deepEqual(codesOf(findings), ['GO_RESTS_ON_ENGAGEMENT_ALONE']);
  assert.equal(findings[0].pillar, 'quality');

  // Engagement as *context* beside a user-judgement item is legal.
  const withContext = tampered(evidencePackage('go'), (draft) => {
    const evidence = draft.evidence as Record<string, Record<string, unknown>[]>;
    evidence.quality.push({ ...evidence.quality[0], measureClass: 'engagement' });
  });
  assert.deepEqual(checkShadowEvidencePackage(withContext), []);
});

test('a go with nothing supporting it in a pillar is reported', () => {
  const unsupported = tampered(evidencePackage('go'), (draft) => {
    const evidence = draft.evidence as Record<string, Record<string, unknown>[]>;
    evidence.safety[0].support = 'hold';
  });
  const findings = checkShadowEvidencePackage(unsupported);
  assert.deepEqual(codesOf(findings), ['GO_WITHOUT_SUPPORT_IN_PILLAR']);
  assert.equal(findings[0].pillar, 'safety');
});

test('a go alongside rollback evidence is a contradiction, reported rather than outvoted', () => {
  const contradictory = tampered(evidencePackage('go'), (draft) => {
    const evidence = draft.evidence as Record<string, Record<string, unknown>[]>;
    evidence.safety.push({ ...evidence.safety[0], support: 'rollback' });
  });
  assert.ok(
    codesOf(checkShadowEvidencePackage(contradictory)).includes('GO_CONTRADICTED_BY_ROLLBACK_EVIDENCE'),
  );
});

test('a go resting on a reading that could not be measured is reported', () => {
  const cannotTell = tampered(evidencePackage('go'), (draft) => {
    const evidence = draft.evidence as Record<string, Record<string, unknown>[]>;
    evidence.reliability[0].sloReading = {
      status: 'inconclusive',
      sloId: 'shadow-latency-p95',
      value: null,
      sampleCount: 3,
      breached: null,
      inconclusiveReason: 'insufficient_sample',
      windowStart: STARTED_AT,
      observedAt: STARTED_AT,
    };
  });
  assert.deepEqual(codesOf(checkShadowEvidencePackage(cannotTell)), [
    'EVIDENCE_SUPPORTS_GO_ON_INCONCLUSIVE_SLO',
  ]);
});

test('an empty or missing pillar is reported at the untyped boundary too', () => {
  const emptied = tampered(evidencePackage(), (draft) => {
    (draft.evidence as Record<string, unknown[]>).reliability = [];
  });
  const findings = checkShadowEvidencePackage(emptied);
  assert.deepEqual(codesOf(findings), ['EVIDENCE_PILLAR_EMPTY']);
  assert.equal(findings[0].pillar, 'reliability');

  const removed = tampered(evidencePackage(), (draft) => {
    delete (draft.evidence as Record<string, unknown>).safety;
  });
  assert.deepEqual(codesOf(checkShadowEvidencePackage(removed)), ['EVIDENCE_PILLAR_MISSING']);
});

test('an evidence citation may not be prose', () => {
  const narrative = tampered(evidencePackage(), (draft) => {
    const evidence = draft.evidence as Record<string, Record<string, unknown>[]>;
    evidence.quality[0].citation = 'Dr Cohen said the reminders helped with the biopsy follow-up';
  });
  assert.deepEqual(codesOf(checkShadowEvidencePackage(narrative)), ['EVIDENCE_CITATION_UNSAFE']);
});

/* ── The contract's own budget table ─────────────────────────────── */

test('the declared run ceiling is above the sum of the module budgets, checkably', () => {
  assert.deepEqual(checkShadowBudgetTable(), []);

  const sum = SHADOW_PIPELINE_CHAIN.reduce(
    (total, module) => total + SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
    0,
  );
  assert.equal(sum, 7_150);
  assert.ok(sum < SHADOW_PIPELINE_TOTAL_BUDGET_MS);

  // Reachable only by handing the checker a table where the violation exists.
  assert.deepEqual(codesOf(checkShadowBudgetTable(SHADOW_MODULE_TIMEOUT_BUDGET_MS, sum - 1)), [
    'TOTAL_BUDGET_BELOW_SUM_OF_MODULES',
  ]);

  const zeroed = { ...SHADOW_MODULE_TIMEOUT_BUDGET_MS, memory: 0 };
  const findings = checkShadowBudgetTable(zeroed);
  assert.deepEqual(codesOf(findings), ['MODULE_BUDGET_NOT_POSITIVE']);
  assert.equal(findings[0].module, 'memory');
});

/* ── Determinism and policy ──────────────────────────────────────── */

test('every checker is deterministic over one input', () => {
  const outcome = degradedOutcome();
  const trace = traceFor(outcome);
  const bundle = bundleFor(outcome);
  assert.deepEqual(checkShadowPipelineOutcome(outcome), checkShadowPipelineOutcome(outcome));
  assert.deepEqual(checkShadowTrace(trace, outcome), checkShadowTrace(trace, outcome));
  assert.deepEqual(
    checkShadowReplay(bundle, observationFor(bundle)),
    checkShadowReplay(bundle, observationFor(bundle)),
  );
  assert.deepEqual(checkShadowEvidencePackage(evidencePackage()), checkShadowEvidencePackage(evidencePackage()));
});

test('the input policy states what this contract refuses to do', () => {
  assert.deepEqual(SHADOW_PIPELINE_INPUT_POLICY, {
    reportWhatTheTaxonomyNames: true,
    noAmbientClock: true,
    everyInstantSuppliedByCaller: true,
    preimageIsPositionalNotSorted: true,
    digestsComeFromTheCaller: true,
    unreadableConsentIsWithheld: true,
    shadowGateOnlyNarrows: true,
  });
});

test('the safe-code pattern is a superset of the shipped pilot one, and both reject separators', () => {
  // Behavioural pin: a code the shipped audit-event builder accepts must pass
  // this contract's pattern. Stating "superset" and testing "identical" would be
  // a comment that is false.
  for (const code of ['quality-primary', 'kill_switch_active', 'a1']) {
    assert.doesNotThrow(() =>
      createPilotAuditEvent({
        version: 'v1',
        eventType: 'exposure_checked',
        participantId: PARTICIPANT_ID,
        occurredAt: STARTED_AT,
        outcome: 'allowed',
        reasonCode: code,
      }),
    );
    assert.equal(SHADOW_SAFE_CODE.test(code), true, `${code} is accepted upstream and rejected here`);
  }
  assert.equal(SHADOW_SAFE_CODE.test(`a${String.fromCharCode(0x1e)}b`), false);
  assert.equal(SHADOW_DIGEST.test('NOTHEX'), false);
  assert.equal(SHADOW_DIGEST.test(DIGEST), true);
  // The widening this contract declares, and nothing more.
  assert.equal(SHADOW_SAFE_CODE.test('run-2027-01-05.0001'), true);
  assert.equal(SHADOW_SAFE_CODE.test('scope:a'), true);
});

test('the safety disposition vocabulary is imported, not restated', () => {
  assert.deepEqual(SAFETY_DISPOSITIONS, ['allow', 'allow_with_redaction', 'block']);
  const wrongDisposition = tampered(degradedOutcome(), (draft) => {
    (draft.deliverable as Record<string, unknown>).safetyDisposition = 'allow_probably';
  });
  assert.deepEqual(codesOf(checkShadowPipelineOutcome(wrongDisposition)), [
    'DELIVERABLE_DISPOSITION_UNKNOWN',
  ]);
});

/** Keeps the compile-time pins load-bearing rather than unused declarations. */
test('the compile-time pilot pins are exercised', () => {
  assert.equal(_pilotReasonToShadow, 'quiet_mode');
  assert.equal(_shadowReasonToPilot, 'quiet_mode');
  assert.equal(_pilotDecisionToShadow.reason, 'revoked');
  assert.equal(_shadowDecisionToPilot.reason, 'revoked');
});

/**
 * The rollback drill, as something that runs (#46, deliverable 5).
 *
 * "Completed rollback game-day report" is a deliverable that is usually
 * satisfied by a person writing a document about a rollback they say they
 * performed. This is the other reading: a function that performs the rollback
 * sequence against fixture state and *generates* the report from what actually
 * happened. `docs/operations/rollback-game-day-report.md` is
 * `renderShadowRollbackReport`'s output, byte for byte, and
 * `tests/operations/shadowRollbackDrill.test.ts` re-runs the drill and fails if
 * the committed document and the freshly generated one differ — so the report
 * cannot describe a drill that stopped passing.
 *
 * Four design decisions, each of which is the difference between a drill and a
 * story about one:
 *
 *  1. **Steps that cannot be exercised say so in the report's own type.**
 *     `not_exercisable` is a step outcome, `ShadowRollbackBlocker` names why,
 *     and the renderer prints them in the same table as the passing steps. Two
 *     of the ten steps are blocked in this sprint — proving the real module
 *     adapters wrote nothing needs #45's orchestrator, and delivering a page
 *     needs a live router — and omitting them would leave a ten-step runbook
 *     with an eight-step drill behind it.
 *  2. **Every step has a precondition, and the report says whether it held.**
 *     A step that "passed" without its precondition is a step that measured
 *     nothing: `confirm_slo_recovery` over a batch below the sample floor would
 *     read an inconclusive reading as recovery, which is exactly the
 *     small-sample failure the reading union exists to prevent.
 *  3. **Timings come from injected instants.** `timingSource` is on the report
 *     so no reader mistakes them for measured wall-clock, and a step that was
 *     never reached carries null rather than a zero.
 *  4. **The recovery is demonstrated, not asserted.** The drill arms the
 *     switches the breaching SLOs name, runs the pipeline again under them, and
 *     re-reads the same SLOs from the new runs. If arming the switch does not
 *     move the metric, the drill halts.
 */

import {
  SHADOW_PIPELINE_CHAIN,
  checkShadowInertness,
  checkShadowPipelineOutcome,
  checkShadowTrace,
  millisBetweenInstants,
  resolveShadowExposure,
  type Instant,
  type ShadowExposureDecision,
  type ShadowPipelineModule,
  type ShadowPipelineRun,
  type ShadowSloReading,
} from '../../src/contracts/v1/shadowPipelineContracts';
import type { IntelligenceModuleName } from '../../src/contracts/v1/moduleContracts';
import { instantFromMillis } from '../../src/contracts/v1/safetyContracts';
import {
  SHADOW_KILL_SWITCH_STANCE,
  killSwitchEnvKey,
  runShadowDrill,
  shadowDrillEnv,
  type ShadowDrillRunResult,
} from './shadowDrillPipeline';
import { expectedStatusForStance } from './shadowKillSwitchDrill';
import {
  SHADOW_SLO_CATALOG,
  evaluateShadowAlert,
  resolveShadowSloOwner,
  type ShadowAlertVerdict,
  type ShadowSloCatalogEntry,
} from './shadowSloCatalog';
import {
  computeShadowSloReading,
  shadowRunObservation,
  type ShadowSloBatch,
} from './shadowSloReadings';
import { emitAndReconcileShadowRunLogs } from './shadowRunLog';

/* ── Steps ───────────────────────────────────────────────────────── */

export type ShadowRollbackStepId =
  | 'confirm_trigger'
  | 'freeze_exposure'
  | 'arm_kill_switches'
  | 'verify_degraded_run'
  | 'verify_logs_reconcile'
  | 'confirm_slo_recovery'
  | 'restore_data_snapshot'
  | 'verify_no_canonical_writes'
  | 'notify_owners'
  | 'stand_down';

/** Declaration order is execution order. Nothing here sorts anything. */
export const SHADOW_ROLLBACK_STEPS = Object.freeze([
  'confirm_trigger',
  'freeze_exposure',
  'arm_kill_switches',
  'verify_degraded_run',
  'verify_logs_reconcile',
  'confirm_slo_recovery',
  'restore_data_snapshot',
  'verify_no_canonical_writes',
  'notify_owners',
  'stand_down',
] as const) satisfies readonly ShadowRollbackStepId[];

export const SHADOW_ROLLBACK_STEP_TITLE: Readonly<Record<ShadowRollbackStepId, string>> =
  Object.freeze({
    confirm_trigger: 'Confirm the trigger is a paging breach and not a thin window',
    freeze_exposure: 'Freeze exposure at the stage that shows nobody anything',
    arm_kill_switches: 'Arm the kill switches the breaching SLOs name',
    verify_degraded_run: 'Run the pipeline under the armed switches and check the stance',
    verify_logs_reconcile: 'Reconcile the post-rollback logs against their traces',
    confirm_slo_recovery: 'Re-read the breaching SLOs from the post-rollback runs',
    restore_data_snapshot: 'Restore the operational data snapshot',
    verify_no_canonical_writes: 'Prove the shadow run wrote nothing to canonical state',
    notify_owners: 'Page the owning rotations and their escalations',
    stand_down: 'Stand the switches back down and confirm a clean baseline run',
  });

export const SHADOW_ROLLBACK_STEP_PRECONDITION: Readonly<Record<ShadowRollbackStepId, string>> =
  Object.freeze({
    confirm_trigger: 'at least one incident window was collected',
    freeze_exposure: 'the exposure stage is shadow_only',
    arm_kill_switches: 'at least one paging SLO names a kill switch',
    verify_degraded_run: 'at least one switch was armed',
    verify_logs_reconcile: 'the post-rollback runs produced traces',
    confirm_slo_recovery: 'every re-read of a tripped SLO is measured, not inconclusive',
    restore_data_snapshot: 'a snapshot port was supplied',
    verify_no_canonical_writes: 'the real orchestrator and its adapters are available',
    notify_owners: 'a live alert router is reachable',
    stand_down: 'the drill reached the end of the sequence',
  });

export type ShadowRollbackStepOutcome = 'passed' | 'failed' | 'not_exercisable' | 'not_reached';

/** Why a step could not be exercised. Closed, so "we skipped it" is not sayable. */
export type ShadowRollbackBlocker =
  | 'requires_real_orchestrator'
  | 'requires_live_alert_router'
  | 'no_snapshot_port_supplied';

export interface ShadowRollbackStepReport {
  readonly stepId: ShadowRollbackStepId;
  readonly title: string;
  readonly precondition: string;
  readonly preconditionHeld: boolean;
  readonly outcome: ShadowRollbackStepOutcome;
  readonly startedAt: Instant | null;
  readonly endedAt: Instant | null;
  readonly elapsedMs: number | null;
  readonly detail: string;
  readonly blocker: ShadowRollbackBlocker | null;
}

export interface ShadowRollbackTrigger {
  readonly sloId: string;
  readonly concern: string;
  readonly state: ShadowAlertVerdict['state'];
  readonly consecutiveBreaches: number;
  readonly notifyRotationId: string | null;
  readonly escalated: boolean;
  readonly latestValue: number | null;
  readonly latestSampleCount: number;
  readonly armsKillSwitchForModule: IntelligenceModuleName | null;
}

export interface ShadowRollbackDrillReport {
  readonly version: 'v1';
  readonly drillId: string;
  readonly generatedBy: 'shadowRollbackDrill';
  /** Injected, never measured. Named so nobody reads these as wall-clock. */
  readonly timingSource: 'injected_instants';
  readonly startedAt: Instant;
  readonly endedAt: Instant;
  readonly totalElapsedMs: number;
  readonly triggers: readonly ShadowRollbackTrigger[];
  readonly armedKillSwitches: readonly IntelligenceModuleName[];
  readonly steps: readonly ShadowRollbackStepReport[];
  readonly outcome: 'rolled_back' | 'halted';
  readonly stepsPassed: number;
  readonly stepsFailed: number;
  readonly stepsNotExercisable: readonly {
    readonly stepId: ShadowRollbackStepId;
    readonly blocker: ShadowRollbackBlocker;
  }[];
  readonly recoveryReadings: readonly {
    readonly sloId: string;
    readonly status: ShadowSloReading['status'];
    readonly value: number | null;
    readonly sampleCount: number;
    readonly breached: boolean | null;
  }[];
}

/* ── Ports and options ───────────────────────────────────────────── */

export interface ShadowSnapshotRestoreResult {
  readonly restored: boolean;
  readonly detail: string;
}

/**
 * The data-rollback half, injected.
 *
 * A port rather than a direct call into `pilotDataBackup`, because a drill that
 * always touched the filesystem could not be run in an environment without one,
 * and because the report has to be able to say "nobody supplied a snapshot" as
 * a distinct outcome from "the restore failed".
 */
export interface ShadowSnapshotPort {
  readonly describe: string;
  readonly restore: () => ShadowSnapshotRestoreResult;
}

export interface ShadowRollbackWindow {
  readonly observedAt: Instant;
  readonly batch: ShadowSloBatch;
}

export interface ShadowRollbackDrillOptions {
  readonly drillId: string;
  /** Two instants per step. Total over the step list, so a new step cannot be untimed. */
  readonly instants: Readonly<
    Record<ShadowRollbackStepId, { readonly startedAt: Instant; readonly endedAt: Instant }>
  >;
  /** The windows that tripped the alert, oldest first. */
  readonly incidentWindows: readonly ShadowRollbackWindow[];
  readonly recovery: {
    readonly startedAt: Instant;
    readonly observedAt: Instant;
    readonly runCount: number;
  };
  readonly snapshotPort: ShadowSnapshotPort | null;
  /** #45's orchestrator at integration; the fixture run by default. */
  readonly run?: ShadowPipelineRun;
  readonly catalog?: readonly ShadowSloCatalogEntry[];
}

/* ── The drill ───────────────────────────────────────────────────── */

function elapsed(from: Instant, to: Instant): number {
  const millis = millisBetweenInstants(from, to);
  if (millis === null) throw new Error('a drill step was given instants that are not instants');
  return millis;
}

export async function runShadowRollbackDrill(
  options: ShadowRollbackDrillOptions,
): Promise<ShadowRollbackDrillReport> {
  const catalog = options.catalog ?? SHADOW_SLO_CATALOG;
  const steps: ShadowRollbackStepReport[] = [];
  let halted = false;

  function record(
    stepId: ShadowRollbackStepId,
    result: {
      preconditionHeld: boolean;
      outcome: ShadowRollbackStepOutcome;
      detail: string;
      blocker?: ShadowRollbackBlocker | null;
    },
  ): void {
    const instants = options.instants[stepId];
    const reached = result.outcome !== 'not_reached';
    steps.push({
      stepId,
      title: SHADOW_ROLLBACK_STEP_TITLE[stepId],
      precondition: SHADOW_ROLLBACK_STEP_PRECONDITION[stepId],
      preconditionHeld: result.preconditionHeld,
      outcome: result.outcome,
      startedAt: reached ? instants.startedAt : null,
      endedAt: reached ? instants.endedAt : null,
      elapsedMs: reached ? elapsed(instants.startedAt, instants.endedAt) : null,
      detail: result.detail,
      blocker: result.blocker ?? null,
    });
    if (result.outcome === 'failed') halted = true;
  }

  function skipRemaining(from: number): void {
    for (let index = from; index < SHADOW_ROLLBACK_STEPS.length; index += 1) {
      record(SHADOW_ROLLBACK_STEPS[index], {
        preconditionHeld: false,
        outcome: 'not_reached',
        detail: 'an earlier step failed and the sequence stopped',
      });
    }
  }

  /* 1 — confirm the trigger */
  const triggers: ShadowRollbackTrigger[] = [];
  const armed: IntelligenceModuleName[] = [];
  const windowsCollected = options.incidentWindows.length > 0;

  if (windowsCollected) {
    for (const entry of catalog) {
      const readings = options.incidentWindows.map((window) =>
        computeShadowSloReading(entry.definition, window.batch, window.observedAt),
      );
      const verdict = evaluateShadowAlert(entry, readings);
      if (verdict.state !== 'paging') continue;
      const latest = readings[readings.length - 1];
      triggers.push({
        sloId: verdict.sloId,
        concern: verdict.concern,
        state: verdict.state,
        consecutiveBreaches: verdict.consecutiveBreaches,
        notifyRotationId: verdict.notifyRotationId,
        escalated: verdict.escalated,
        latestValue: latest.value,
        latestSampleCount: latest.sampleCount,
        armsKillSwitchForModule: verdict.armsKillSwitchForModule,
      });
      const module = verdict.armsKillSwitchForModule;
      if (module !== null && armed.indexOf(module) === -1) armed.push(module);
    }
  }

  record('confirm_trigger', {
    preconditionHeld: windowsCollected,
    outcome: windowsCollected && triggers.length > 0 ? 'passed' : 'failed',
    detail:
      triggers.length > 0
        ? `${triggers.length} SLO(s) paging: ${triggers.map((trigger) => trigger.sloId).join(', ')}`
        : 'no SLO reached a paging state over the incident windows',
  });
  if (halted) {
    skipRemaining(1);
    return assemble(options, triggers, armed, steps, []);
  }

  /* 2 — freeze exposure */
  const exposure: ShadowExposureDecision = resolveShadowExposure({
    participantId: 'drill-participant',
    stage: 'shadow_only',
    cohortSize: 0,
    pilotDecision: { allowed: true, reason: 'authorized' },
    consent: {
      state: 'granted',
      participantId: 'drill-participant',
      scopes: ['shadow_execution'],
      grantedAt: '2027-01-01T00:00:00.000Z',
      revokedAt: null,
    },
  });
  const frozen = exposure.allowed === false && exposure.reason === 'stage_is_shadow_only';
  record('freeze_exposure', {
    preconditionHeld: exposure.stage === 'shadow_only',
    outcome: frozen ? 'passed' : 'failed',
    detail: frozen
      ? 'a participant with granted consent is still refused at shadow_only, cap 0'
      : `exposure resolved to allowed=${String(exposure.allowed)} reason=${exposure.reason}`,
  });
  if (halted) {
    skipRemaining(2);
    return assemble(options, triggers, armed, steps, []);
  }

  /* 3 — arm the switches */
  record('arm_kill_switches', {
    preconditionHeld: armed.length > 0,
    outcome: armed.length > 0 ? 'passed' : 'failed',
    detail:
      armed.length > 0
        ? `armed: ${armed.join(', ')}`
        : 'the paging SLOs name no kill switch; this is a stop-the-drill conversation, not a lever',
  });
  if (halted) {
    skipRemaining(3);
    return assemble(options, triggers, armed, steps, []);
  }

  /* 4 — run under the armed switches */
  const overrides: Record<string, string> = {};
  for (const module of armed) {
    if (SHADOW_PIPELINE_CHAIN.indexOf(module as ShadowPipelineModule) === -1) continue;
    overrides[killSwitchEnvKey(module as ShadowPipelineModule)] = 'true';
  }
  const env = shadowDrillEnv(overrides);

  const recoveryRuns: ShadowDrillRunResult[] = [];
  for (let index = 0; index < options.recovery.runCount; index += 1) {
    recoveryRuns.push(
      await runShadowDrill(
        {
          runId: `${options.drillId}-recovery-${String(index).padStart(3, '0')}`,
          scopeId: 'drill-scope',
          startedAt: options.recovery.startedAt,
          env,
        },
        options.run,
      ),
    );
  }

  const stanceFindings: string[] = [];
  for (const result of recoveryRuns) {
    if (checkShadowPipelineOutcome(result.bundle.outcome).length > 0) {
      stanceFindings.push(`${result.bundle.runId}: the outcome is malformed`);
    }
    if (checkShadowTrace(result.bundle.trace, result.bundle.outcome).length > 0) {
      stanceFindings.push(`${result.bundle.runId}: the trace is malformed`);
    }
    for (const stage of result.bundle.trace.stages) {
      const isArmed = armed.indexOf(stage.module) !== -1;
      if (isArmed) {
        const expectedStatus = expectedStatusForStance(SHADOW_KILL_SWITCH_STANCE[stage.module]);
        if (stage.reason !== 'kill_switch_active' || stage.status !== expectedStatus) {
          stanceFindings.push(
            `${stage.module}: expected ${expectedStatus} for kill_switch_active, saw ${stage.status}/${String(stage.reason)}`,
          );
        }
      } else if (stage.reason === 'kill_switch_active') {
        stanceFindings.push(`${stage.module}: names a switch that was not armed`);
      }
    }
  }
  record('verify_degraded_run', {
    preconditionHeld: armed.length > 0,
    outcome: stanceFindings.length === 0 ? 'passed' : 'failed',
    detail:
      stanceFindings.length === 0
        ? `${recoveryRuns.length} runs; every armed module degraded to its documented stance and no other module named a switch`
        : stanceFindings.join('; '),
  });
  if (halted) {
    skipRemaining(4);
    return assemble(options, triggers, armed, steps, []);
  }

  /* 5 — reconcile the logs */
  const logged = recoveryRuns.map((result) => ({
    trace: result.bundle.trace,
    bundleDigest: result.bundle.bundleDigest,
  }));
  const { report: reconciliation } = emitAndReconcileShadowRunLogs(logged);
  record('verify_logs_reconcile', {
    preconditionHeld: logged.length > 0,
    outcome: reconciliation.reconciled ? 'passed' : 'failed',
    detail: `${reconciliation.matchedPairs} of ${reconciliation.tracePairs} (runId, module) pairs matched in both directions; ${reconciliation.privacyViolations.length} privacy violations`,
  });
  if (halted) {
    skipRemaining(5);
    return assemble(options, triggers, armed, steps, []);
  }

  /* 6 — re-read the tripped SLOs */
  const recoveryBatch: ShadowSloBatch = {
    status: 'collected',
    observations: recoveryRuns.map((result) => shadowRunObservation(result, true)),
  };
  const recoveryReadings: ShadowRollbackDrillReport['recoveryReadings'][number][] = [];
  let allMeasured = true;
  let stillBreaching = 0;
  for (const trigger of triggers) {
    const entry = catalog.filter((candidate) => candidate.definition.sloId === trigger.sloId)[0];
    if (entry === undefined) continue;
    const reading = computeShadowSloReading(
      entry.definition,
      recoveryBatch,
      options.recovery.observedAt,
    );
    if (reading.status !== 'measured') allMeasured = false;
    if (reading.breached === true) stillBreaching += 1;
    recoveryReadings.push({
      sloId: reading.sloId,
      status: reading.status,
      value: reading.value,
      sampleCount: reading.sampleCount,
      breached: reading.breached,
    });
  }
  record('confirm_slo_recovery', {
    preconditionHeld: allMeasured,
    outcome: allMeasured && stillBreaching === 0 ? 'passed' : 'failed',
    detail: !allMeasured
      ? 'a re-read came back inconclusive; a thin window is not a recovery'
      : `${recoveryReadings.length} tripped SLO(s) re-read, ${stillBreaching} still breaching`,
  });
  if (halted) {
    skipRemaining(6);
    return assemble(options, triggers, armed, steps, recoveryReadings);
  }

  /* 7 — restore the data snapshot */
  if (options.snapshotPort === null) {
    record('restore_data_snapshot', {
      preconditionHeld: false,
      outcome: 'not_exercisable',
      detail: 'no snapshot port was supplied, so the data half of the rollback was not exercised',
      blocker: 'no_snapshot_port_supplied',
    });
  } else {
    const restore = options.snapshotPort.restore();
    record('restore_data_snapshot', {
      preconditionHeld: true,
      outcome: restore.restored ? 'passed' : 'failed',
      detail: `${options.snapshotPort.describe}: ${restore.detail}`,
    });
  }
  if (halted) {
    skipRemaining(7);
    return assemble(options, triggers, armed, steps, recoveryReadings);
  }

  /* 8 — canonical writes: blocked on the real orchestrator */
  const inertnessFindings = recoveryRuns.reduce(
    (total, result) => total + checkShadowInertness(result.bundle.outcome).length,
    0,
  );
  record('verify_no_canonical_writes', {
    preconditionHeld: false,
    outcome: 'not_exercisable',
    detail: `checkShadowInertness reported ${inertnessFindings} findings over the fixture outcomes, which proves the result carries no callable; proving the module adapters wrote nothing needs #45's real adapters and is not exercised here`,
    blocker: 'requires_real_orchestrator',
  });

  /* 9 — paging: blocked on a live router */
  const routed: string[] = [];
  for (const trigger of triggers) {
    const entry = catalog.filter((candidate) => candidate.definition.sloId === trigger.sloId)[0];
    if (entry === undefined) continue;
    const owner = resolveShadowSloOwner(entry.definition.owner);
    routed.push(
      owner === null
        ? `${trigger.sloId}: UNROUTABLE`
        : `${trigger.sloId} -> ${owner.primary.channelCode} then ${owner.escalation.channelCode}`,
    );
  }
  record('notify_owners', {
    preconditionHeld: false,
    outcome: 'not_exercisable',
    detail: `every owner resolved to a rotation pair (${routed.join('; ')}); delivering the page needs a live router and is not exercised here`,
    blocker: 'requires_live_alert_router',
  });

  /* 10 — stand down */
  const standDown = await runShadowDrill(
    {
      runId: `${options.drillId}-stand-down`,
      scopeId: 'drill-scope',
      startedAt: options.recovery.startedAt,
      env: shadowDrillEnv(),
    },
    options.run,
  );
  const cleanBaseline =
    checkShadowPipelineOutcome(standDown.bundle.outcome).length === 0 &&
    checkShadowTrace(standDown.bundle.trace, standDown.bundle.outcome).length === 0 &&
    standDown.bundle.trace.stages.every((stage) => stage.reason !== 'kill_switch_active');
  record('stand_down', {
    preconditionHeld: true,
    outcome: cleanBaseline ? 'passed' : 'failed',
    detail: cleanBaseline
      ? 'switches stood down; the baseline run is contract-clean and names no switch'
      : 'the baseline run after stand-down still names a switch or is malformed',
  });

  return assemble(options, triggers, armed, steps, recoveryReadings);
}

function assemble(
  options: ShadowRollbackDrillOptions,
  triggers: readonly ShadowRollbackTrigger[],
  armed: readonly IntelligenceModuleName[],
  steps: readonly ShadowRollbackStepReport[],
  recoveryReadings: ShadowRollbackDrillReport['recoveryReadings'],
): ShadowRollbackDrillReport {
  const first = options.instants[SHADOW_ROLLBACK_STEPS[0]].startedAt;
  const last = options.instants[SHADOW_ROLLBACK_STEPS[SHADOW_ROLLBACK_STEPS.length - 1]].endedAt;
  const failed = steps.filter((step) => step.outcome === 'failed').length;
  return Object.freeze({
    version: 'v1' as const,
    drillId: options.drillId,
    generatedBy: 'shadowRollbackDrill' as const,
    timingSource: 'injected_instants' as const,
    startedAt: first,
    endedAt: last,
    totalElapsedMs: elapsed(first, last),
    triggers: Object.freeze(triggers),
    armedKillSwitches: Object.freeze(armed),
    steps: Object.freeze(steps),
    outcome: failed === 0 ? ('rolled_back' as const) : ('halted' as const),
    stepsPassed: steps.filter((step) => step.outcome === 'passed').length,
    stepsFailed: failed,
    stepsNotExercisable: Object.freeze(
      steps
        .filter((step) => step.outcome === 'not_exercisable' && step.blocker !== null)
        .map((step) => ({ stepId: step.stepId, blocker: step.blocker as ShadowRollbackBlocker })),
    ),
    recoveryReadings: Object.freeze(recoveryReadings),
  });
}

/* ── Instants ────────────────────────────────────────────────────── */

/**
 * Build the total instant record from a start and a literal per-step duration
 * table.
 *
 * The durations are the caller's data — the drill reads no clock — and the
 * report labels them `injected_instants` so a reader knows a step's "4200ms" is
 * what the operator recorded and not something this process measured.
 */
export function shadowRollbackInstants(
  startedAt: Instant,
  durationsMs: Readonly<Record<ShadowRollbackStepId, number>>,
  gapMs = 0,
): Readonly<Record<ShadowRollbackStepId, { readonly startedAt: Instant; readonly endedAt: Instant }>> {
  const base = millisBetweenInstants('1970-01-01T00:00:00.000Z', startedAt);
  if (base === null) throw new Error('the drill start is not an instant');
  const instants: Partial<
    Record<ShadowRollbackStepId, { startedAt: Instant; endedAt: Instant }>
  > = {};
  let cursor = base;
  for (const stepId of SHADOW_ROLLBACK_STEPS) {
    const from = instantFromMillis(cursor);
    cursor += durationsMs[stepId];
    const to = instantFromMillis(cursor);
    cursor += gapMs;
    if (from === null || to === null) throw new Error(`step ${stepId} lands outside the instant range`);
    instants[stepId] = { startedAt: from, endedAt: to };
  }
  return Object.freeze(instants) as Readonly<
    Record<ShadowRollbackStepId, { readonly startedAt: Instant; readonly endedAt: Instant }>
  >;
}

/* ── Rendering ───────────────────────────────────────────────────── */

function millisColumn(elapsedMs: number | null): string {
  return elapsedMs === null ? '—' : `${elapsedMs}`;
}

function valueColumn(value: number | null): string {
  return value === null ? '—' : `${value}`;
}

/**
 * The game-day report as markdown, generated from a report the drill produced.
 *
 * `docs/operations/rollback-game-day-report.md` is exactly this string, and the
 * test regenerates it and compares. That is the whole mechanism behind calling
 * the game day "completed": the document cannot describe a drill that no longer
 * passes, because the drill is what writes it.
 */
export function renderShadowRollbackReport(report: ShadowRollbackDrillReport): string {
  const lines: string[] = [];

  lines.push('# Shadow release rollback — game-day report');
  lines.push('');
  lines.push(
    '**Generated by `renderShadowRollbackReport` from a run of `runShadowRollbackDrill`.** Do not edit by hand: `tests/operations/shadowRollbackDrill.test.ts` re-runs the drill and fails if this file and the freshly generated report differ.',
  );
  lines.push('');
  lines.push(`- Drill: \`${report.drillId}\``);
  lines.push(`- Outcome: **${report.outcome}**`);
  lines.push(`- Window: \`${report.startedAt}\` → \`${report.endedAt}\` (${report.totalElapsedMs}ms)`);
  lines.push(
    `- Timing source: \`${report.timingSource}\` — every duration below is an operator-recorded instant, not wall-clock measured by this process.`,
  );
  lines.push(
    `- Steps: ${report.stepsPassed} passed, ${report.stepsFailed} failed, ${report.stepsNotExercisable.length} not exercisable.`,
  );
  lines.push('');

  lines.push('## What tripped');
  lines.push('');
  if (report.triggers.length === 0) {
    lines.push('Nothing reached a paging state.');
  } else {
    lines.push('| SLO | concern | consecutive breaches | latest value | samples | paged | escalated | arms |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const trigger of report.triggers) {
      lines.push(
        `| \`${trigger.sloId}\` | ${trigger.concern} | ${trigger.consecutiveBreaches} | ${valueColumn(trigger.latestValue)} | ${trigger.latestSampleCount} | \`${String(trigger.notifyRotationId)}\` | ${String(trigger.escalated)} | ${trigger.armsKillSwitchForModule === null ? '—' : `\`${trigger.armsKillSwitchForModule}\``} |`,
      );
    }
  }
  lines.push('');
  lines.push(
    `Kill switches armed: ${report.armedKillSwitches.length === 0 ? 'none' : report.armedKillSwitches.map((module) => `\`${module}\``).join(', ')}.`,
  );
  lines.push('');

  lines.push('## The sequence');
  lines.push('');
  lines.push('| # | step | outcome | precondition held | elapsed (ms) | detail |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (let index = 0; index < report.steps.length; index += 1) {
    const step = report.steps[index];
    lines.push(
      `| ${index + 1} | \`${step.stepId}\` | **${step.outcome}** | ${String(step.preconditionHeld)} | ${millisColumn(step.elapsedMs)} | ${step.detail} |`,
    );
  }
  lines.push('');

  lines.push('## What could not be exercised');
  lines.push('');
  if (report.stepsNotExercisable.length === 0) {
    lines.push('Every step in the sequence was exercised.');
  } else {
    lines.push('| step | blocker | precondition |');
    lines.push('| --- | --- | --- |');
    for (const blocked of report.stepsNotExercisable) {
      lines.push(
        `| \`${blocked.stepId}\` | \`${blocked.blocker}\` | ${SHADOW_ROLLBACK_STEP_PRECONDITION[blocked.stepId]} |`,
      );
    }
  }
  lines.push('');

  lines.push('## SLOs re-read after the rollback');
  lines.push('');
  if (report.recoveryReadings.length === 0) {
    lines.push('No SLO was re-read: the drill halted before the recovery step.');
  } else {
    lines.push('| SLO | status | value | samples | breached |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const reading of report.recoveryReadings) {
      lines.push(
        `| \`${reading.sloId}\` | ${reading.status} | ${valueColumn(reading.value)} | ${reading.sampleCount} | ${String(reading.breached)} |`,
      );
    }
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

/**
 * #46, deliverable 5: the rollback runbook's drill, executed.
 *
 * "Completed rollback game-day report" is satisfied here by running the
 * sequence and generating the report from the run —
 * `docs/operations/rollback-game-day-report.md` is
 * `renderShadowRollbackReport`'s output byte for byte, and the last test in this
 * file regenerates it and fails on any difference. A report written by hand
 * describes a drill that may since have stopped passing; this one cannot.
 *
 * The scenario is a real chain of consequences rather than a hand-set flag:
 * `coaching` starts timing out, which starves the fail-closed gate downstream
 * of it, which withholds those runs — so two SLOs breach for one cause, they
 * name two different kill switches, and arming both is what the drill has to
 * show fixes the metric. The recovery is *measured* from runs made under the
 * armed switches, not asserted.
 *
 * The data half of the rollback is exercised for real, through
 * `lib/operations/pilotDataBackup.ts` over a temporary directory, so the
 * `restore_data_snapshot` step is a genuine pass. The two steps that cannot be
 * exercised in this sprint — proving the real adapters wrote nothing, and
 * delivering a page — are asserted to appear as `not_exercisable` with their
 * blockers, because a drill that quietly omitted them would report a ten-step
 * rollback it performed eight steps of.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  checkShadowPipelineOutcome,
  checkShadowTrace,
  type ShadowPipelineRun,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { backupPilotData, restorePilotData } from '../../lib/operations/pilotDataBackup.ts';
import {
  createShadowDrillRun,
  runShadowDrill,
  shadowDrillEnv,
} from '../../lib/operations/shadowDrillPipeline.ts';
import {
  SHADOW_ROLLBACK_STEPS,
  renderShadowRollbackReport,
  runShadowRollbackDrill,
  shadowRollbackInstants,
  type ShadowRollbackDrillOptions,
  type ShadowRollbackStepId,
  type ShadowSnapshotPort,
} from '../../lib/operations/shadowRollbackDrill.ts';
import { shadowRunObservation, type ShadowRunObservation } from '../../lib/operations/shadowSloReadings.ts';

const DRILL_ID = 'game-day-2027-01-14';
const DRILL_START = '2027-01-14T09:00:00.000Z';

/** Injected step durations, as literal operator-recorded data. */
const STEP_DURATIONS_MS: Readonly<Record<ShadowRollbackStepId, number>> = Object.freeze({
  confirm_trigger: 90000,
  freeze_exposure: 45000,
  arm_kill_switches: 30000,
  verify_degraded_run: 120000,
  verify_logs_reconcile: 60000,
  confirm_slo_recovery: 300000,
  restore_data_snapshot: 240000,
  verify_no_canonical_writes: 15000,
  notify_owners: 20000,
  stand_down: 75000,
});

/** One incident window: twenty runs, four of them with coaching abandoned at its budget. */
async function incidentObservations(windowIndex: number): Promise<ShadowRunObservation[]> {
  const built: ShadowRunObservation[] = [];
  for (let index = 0; index < 20; index += 1) {
    const result = await runShadowDrill({
      runId: `incident-w${windowIndex}-r${String(index).padStart(3, '0')}`,
      scopeId: 'drill-scope',
      startedAt: '2027-01-14T08:00:00.000Z',
      env: shadowDrillEnv(),
      behaviours: index < 4 ? { coaching: { kind: 'times_out' } } : {},
      costMicros: 1800,
    });
    assert.deepEqual(checkShadowPipelineOutcome(result.bundle.outcome), []);
    assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
    built.push(shadowRunObservation(result, true));
  }
  return built;
}

async function incidentWindows() {
  const observedAt = ['2027-01-14T07:00:00.000Z', '2027-01-14T08:00:00.000Z', '2027-01-14T09:00:00.000Z'];
  const windows = [];
  for (let index = 0; index < observedAt.length; index += 1) {
    windows.push({
      observedAt: observedAt[index],
      batch: { status: 'collected' as const, observations: await incidentObservations(index) },
    });
  }
  return windows;
}

/** A snapshot port backed by the shipped backup/restore, over a temporary tree. */
function realSnapshotPort(): { port: ShadowSnapshotPort; cleanup: () => void } {
  const source = mkdtempSync(path.join(tmpdir(), 'shadow-drill-data-'));
  const backupRoot = mkdtempSync(path.join(tmpdir(), 'shadow-drill-backup-'));
  const target = mkdtempSync(path.join(tmpdir(), 'shadow-drill-restore-'));
  mkdirSync(path.join(source, 'participants'), { recursive: true });
  writeFileSync(
    path.join(source, 'pilot-trust.json'),
    JSON.stringify({ version: 'v1', participants: {}, auditEvents: [], incidents: [] }, null, 2),
  );
  const backup = backupPilotData({
    sourceDir: source,
    backupRoot,
    label: 'game-day',
    now: new Date('2027-01-14T09:00:00.000Z'),
  });

  return {
    port: {
      describe: 'pilotDataBackup snapshot over a temporary tree',
      restore: () => {
        const result = restorePilotData({
          backupPath: backup.backupPath,
          targetDir: target,
          replaceExisting: true,
        });
        const trust = readFileSync(path.join(result.restoredTo, 'pilot-trust.json'), 'utf8');
        return {
          restored: trust.indexOf('"version": "v1"') !== -1,
          detail: 'restored the pilot trust store and participant tree from the pre-drill snapshot',
        };
      },
    },
    cleanup: () => {
      for (const dir of [source, backupRoot, target]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function drillOptions(
  overrides: Partial<ShadowRollbackDrillOptions> = {},
): Promise<ShadowRollbackDrillOptions> {
  return {
    drillId: DRILL_ID,
    instants: shadowRollbackInstants(DRILL_START, STEP_DURATIONS_MS),
    incidentWindows: await incidentWindows(),
    recovery: {
      startedAt: '2027-01-14T10:00:00.000Z',
      observedAt: '2027-01-14T11:00:00.000Z',
      runCount: 20,
    },
    snapshotPort: null,
    ...overrides,
  };
}

test('the drill trips two SLOs from one cause and arms the switches they name', async () => {
  const report = await runShadowRollbackDrill(await drillOptions());

  assert.deepEqual(
    report.triggers.map((trigger) => trigger.sloId),
    ['shadow-pipeline-withheld-rate', 'shadow-module-timeout-rate'],
  );
  assert.deepEqual([...report.armedKillSwitches], ['safety', 'coaching']);
  const withheld = report.triggers[0];
  assert.equal(withheld.latestValue, 0.2);
  assert.equal(withheld.latestSampleCount, 20);
  assert.equal(withheld.escalated, true);
  assert.equal(withheld.notifyRotationId, 'shadow-oncall-backend-lead');
  const timeouts = report.triggers[1];
  assert.equal(timeouts.latestValue, 0.025);
  assert.equal(timeouts.latestSampleCount, 160);
});

test('the drill demonstrates recovery rather than asserting it', async () => {
  const report = await runShadowRollbackDrill(await drillOptions());
  assert.deepEqual(
    report.recoveryReadings.map((reading) => [reading.sloId, reading.status, reading.value, reading.breached]),
    [
      ['shadow-pipeline-withheld-rate', 'measured', 0, false],
      ['shadow-module-timeout-rate', 'measured', 0, false],
    ],
  );
  const recovery = report.steps.find((step) => step.stepId === 'confirm_slo_recovery');
  assert.ok(recovery);
  assert.equal(recovery.outcome, 'passed');
  assert.equal(recovery.preconditionHeld, true);
});

test('every step is timed from injected instants and a not-reached step is not timed at all', async () => {
  const report = await runShadowRollbackDrill(await drillOptions());
  assert.equal(report.timingSource, 'injected_instants');
  assert.equal(report.steps.length, SHADOW_ROLLBACK_STEPS.length);
  assert.deepEqual(
    report.steps.map((step) => step.stepId),
    [...SHADOW_ROLLBACK_STEPS],
  );
  for (const step of report.steps) {
    assert.equal(step.elapsedMs, STEP_DURATIONS_MS[step.stepId], step.stepId);
    assert.ok(step.startedAt !== null && step.endedAt !== null, step.stepId);
  }
  assert.equal(report.totalElapsedMs, 995000);
});

test('a step that cannot be exercised says so in the report type rather than being omitted', async () => {
  const report = await runShadowRollbackDrill(await drillOptions());
  assert.deepEqual(
    report.stepsNotExercisable.map((step) => [step.stepId, step.blocker]),
    [
      ['restore_data_snapshot', 'no_snapshot_port_supplied'],
      ['verify_no_canonical_writes', 'requires_real_orchestrator'],
      ['notify_owners', 'requires_live_alert_router'],
    ],
  );
  for (const blocked of report.stepsNotExercisable) {
    const step = report.steps.find((candidate) => candidate.stepId === blocked.stepId);
    assert.ok(step);
    assert.equal(step.outcome, 'not_exercisable');
    assert.equal(step.preconditionHeld, false);
    assert.notEqual(step.detail, '');
  }
  assert.equal(report.outcome, 'rolled_back', 'a blocked step is not a failed step');
});

test('the data half of the rollback is exercised for real when a snapshot port is supplied', async () => {
  const { port, cleanup } = realSnapshotPort();
  try {
    const report = await runShadowRollbackDrill(await drillOptions({ snapshotPort: port }));
    const step = report.steps.find((candidate) => candidate.stepId === 'restore_data_snapshot');
    assert.ok(step);
    assert.equal(step.outcome, 'passed');
    assert.equal(step.preconditionHeld, true);
    assert.deepEqual(
      report.stepsNotExercisable.map((blocked) => blocked.stepId),
      ['verify_no_canonical_writes', 'notify_owners'],
    );
    assert.equal(report.stepsPassed, 8);
    assert.equal(report.stepsFailed, 0);
  } finally {
    cleanup();
  }
});

test('a drill whose recovery window is too thin halts instead of reporting a recovery', async () => {
  const report = await runShadowRollbackDrill(
    await drillOptions({
      recovery: {
        startedAt: '2027-01-14T10:00:00.000Z',
        observedAt: '2027-01-14T11:00:00.000Z',
        runCount: 19,
      },
    }),
  );

  const recovery = report.steps.find((step) => step.stepId === 'confirm_slo_recovery');
  assert.ok(recovery);
  assert.equal(recovery.preconditionHeld, false);
  assert.equal(recovery.outcome, 'failed');
  assert.equal(report.outcome, 'halted');
  const later = report.steps.filter(
    (step) => SHADOW_ROLLBACK_STEPS.indexOf(step.stepId) > SHADOW_ROLLBACK_STEPS.indexOf('confirm_slo_recovery'),
  );
  for (const step of later) {
    assert.equal(step.outcome, 'not_reached', step.stepId);
    assert.equal(step.elapsedMs, null, 'a step nobody reached took no time');
  }
});

test('a mitigation that does not move the metric halts the drill rather than reporting recovery', async () => {
  // The armed switches take effect exactly as documented — `memory` is not one
  // of them — and the timeout rate stays above its threshold anyway. This is
  // the case a drill must never call a recovery: the switch was thrown, the
  // stance was correct, and the number did not move.
  const stubbornRun: ShadowPipelineRun = (input, adapters) =>
    createShadowDrillRun({ safetyDisposition: 'allow' })(input, {
      ...adapters,
      memory: async () => ({
        status: 'timed_out',
        module: 'memory',
        contributed: false,
        reason: 'budget_exhausted',
        failureCode: null,
        outputDigest: null,
        elapsedMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS.memory,
        budgetMs: SHADOW_MODULE_TIMEOUT_BUDGET_MS.memory,
      }),
    });

  const report = await runShadowRollbackDrill(await drillOptions({ run: stubbornRun }));

  const degraded = report.steps.find((step) => step.stepId === 'verify_degraded_run');
  assert.ok(degraded);
  assert.equal(degraded.outcome, 'passed', 'the armed switches still reached their documented stance');

  const recovery = report.steps.find((step) => step.stepId === 'confirm_slo_recovery');
  assert.ok(recovery);
  assert.equal(recovery.preconditionHeld, true, 'the window was thick enough; the metric simply did not move');
  assert.equal(recovery.outcome, 'failed');
  assert.equal(recovery.detail, '2 tripped SLO(s) re-read, 1 still breaching');
  assert.equal(report.outcome, 'halted');
  assert.deepEqual(
    report.recoveryReadings.map((reading) => [reading.sloId, reading.breached]),
    [
      ['shadow-pipeline-withheld-rate', false],
      ['shadow-module-timeout-rate', true],
    ],
  );
});

test('a drill with no incident halts at the first step and reaches nothing else', async () => {
  const report = await runShadowRollbackDrill(await drillOptions({ incidentWindows: [] }));
  assert.equal(report.outcome, 'halted');
  assert.equal(report.steps[0].stepId, 'confirm_trigger');
  assert.equal(report.steps[0].outcome, 'failed');
  assert.equal(report.steps[0].preconditionHeld, false);
  assert.equal(report.steps.length, SHADOW_ROLLBACK_STEPS.length);
  for (const step of report.steps.slice(1)) assert.equal(step.outcome, 'not_reached', step.stepId);
});

test('the committed game-day report is the one this drill just produced', async () => {
  const { port, cleanup } = realSnapshotPort();
  try {
    const report = await runShadowRollbackDrill(await drillOptions({ snapshotPort: port }));
    const rendered = renderShadowRollbackReport(report);
    const reportPath = path.join(process.cwd(), 'docs', 'operations', 'rollback-game-day-report.md');
    // The generator lives here on purpose: the only way to produce the
    // committed report is to run the drill, so the document cannot describe a
    // rollback that was never performed.
    //   MAYBESITTER_WRITE_GAME_DAY_REPORT=1 npm run test:sprint11
    if (process.env.MAYBESITTER_WRITE_GAME_DAY_REPORT === '1') {
      writeFileSync(reportPath, rendered, 'utf8');
    }
    assert.equal(
      rendered,
      readFileSync(reportPath, 'utf8'),
      'docs/operations/rollback-game-day-report.md is stale: re-run the drill with MAYBESITTER_WRITE_GAME_DAY_REPORT=1 and commit its output',
    );
  } finally {
    cleanup();
  }
});

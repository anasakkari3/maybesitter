/**
 * #46, acceptance criterion "privacy-safe logs reconcile with traces".
 *
 * Two claims, and neither is allowed to be satisfied by the other's slack.
 *
 * **The logs are privacy-safe**, and the judge is the *shipped*
 * `validateAnalyticsEvent` — the function the product already ships and already
 * tests — rather than a second copy of its `PRIVATE_KEY` regex living in this
 * track. Every forbidden class in `SHADOW_FORBIDDEN_LOG_KEY_CLASSES` is driven
 * through it, one at a time, with a probe that no other class in the list
 * matches: a class masked by a neighbour could be deleted with no test moving,
 * which is the hole `tests/safety/validators.test.ts` found in 22 of 41 lexicon
 * entries. Content is also attacked through the *value* side — a nested object
 * and an overlong string under an innocent key name — because a scan that only
 * reads key names is a scan that ships the transcript in `properties.note`.
 *
 * **The logs reconcile with the traces**, at `(runId, module)` **pair**
 * granularity and with multiplicity. Sprint 08 reported perfect agreement
 * between two readers that disagreed on 38% of inputs, because it compared
 * deduplicated sets of identifiers: a line duplicated for one run and missing
 * for another cancels out exactly. The cross-run test below constructs that
 * shape, asserts this reconciler reports both findings, and asserts the
 * set-based comparison would have called it perfect — the second half is what
 * stops the first from being a coincidence.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_FORBIDDEN_LOG_KEY_CLASSES,
  SHADOW_LOG_RECONCILIATION_FIELDS,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_CHAIN_POSITION,
  checkShadowLogReconciliation,
  checkShadowTrace,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { validateAnalyticsEvent } from '../../lib/analytics/privacySafeEvents.ts';
import { ANALYTICS_EVENT_CONTRACT_VERSION } from '../../src/contracts/v1/analyticsEventContracts.ts';
import {
  emitShadowRunLog,
  reconcileShadowRunLogs,
  shadowLogPrivacyErrors,
  type ShadowRunLogLine,
} from '../../lib/operations/shadowRunLog.ts';
import { runShadowDrill, shadowDrillEnv } from '../../lib/operations/shadowDrillPipeline.ts';

async function runFor(runId: string) {
  const result = await runShadowDrill({
    runId,
    scopeId: 'drill-scope',
    startedAt: '2027-01-14T11:00:00.000Z',
    env: shadowDrillEnv(),
  });
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
  return { trace: result.bundle.trace, bundleDigest: result.bundle.bundleDigest };
}

/**
 * The reconciler this one replaces: the deduplicated set of stage ids over the
 * whole batch, which is what Sprint 08 compared. It cannot see multiplicity and
 * it cannot see which run a stage belonged to, so a stage logged twice in one
 * run and not at all in another is, to it, a stage that appears on both sides.
 */
function setBasedAgreement(
  runs: readonly { trace: { runId: string; stages: readonly { module: string }[] } }[],
  lines: readonly ShadowRunLogLine[],
): boolean {
  const traceIds: string[] = [];
  const logIds: string[] = [];
  for (const run of runs) {
    for (const stage of run.trace.stages) {
      if (traceIds.indexOf(stage.module) === -1) traceIds.push(stage.module);
    }
  }
  for (const line of lines) {
    if (line.module === null) continue;
    if (logIds.indexOf(line.module) === -1) logIds.push(line.module);
  }
  return (
    traceIds.length === logIds.length && traceIds.every((id) => logIds.indexOf(id) !== -1)
  );
}

/* ── What a line carries ─────────────────────────────────────────── */

test('every emitted line carries the reconciliation fields the contract names', async () => {
  const run = await runFor('drill-run-log-001');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);

  assert.equal(lines.length, SHADOW_PIPELINE_CHAIN.length + 2, 'one line per stage, plus start and finish');
  for (const line of lines) {
    for (const field of SHADOW_LOG_RECONCILIATION_FIELDS) {
      assert.ok(field in line, `an emitted line has no ${field}`);
    }
    assert.equal(line.runId, run.trace.runId);
    assert.equal(line.bundleDigest, run.bundleDigest);
  }

  const stageLines = lines.filter((line) => line.module !== null);
  assert.equal(stageLines.length, SHADOW_PIPELINE_CHAIN.length);
  for (const line of stageLines) {
    assert.equal(line.stagePosition, SHADOW_PIPELINE_CHAIN_POSITION[line.module!]);
  }
  for (const line of lines.filter((candidate) => candidate.module === null)) {
    assert.equal(line.stagePosition, null, 'a run-level line locates no stage');
  }
});

test('every emitted line satisfies the contract reconciliation check', async () => {
  const run = await runFor('drill-run-log-002');
  for (const line of emitShadowRunLog(run.trace, run.bundleDigest)) {
    assert.deepEqual(
      checkShadowLogReconciliation(line, run.trace, run.bundleDigest),
      [],
      `${String(line.kind)} line was rejected by the contract`,
    );
  }
});

test('every emitted line passes the shipped analytics privacy judgement', async () => {
  const run = await runFor('drill-run-log-003');
  for (const line of emitShadowRunLog(run.trace, run.bundleDigest)) {
    assert.deepEqual(shadowLogPrivacyErrors(line), [], 'an emitted line carries a private-looking property');
  }
});

/* ── Reconciliation, both directions ─────────────────────────────── */

test('a full log reconciles with its trace in both directions', async () => {
  const run = await runFor('drill-run-log-004');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const report = reconcileShadowRunLogs([run], lines);

  assert.equal(report.reconciled, true);
  assert.equal(report.tracePairs, 8);
  assert.equal(report.logPairs, 8);
  assert.equal(report.matchedPairs, 8);
  assert.equal(report.runLevelLines, 2);
  assert.deepEqual(report.stagesWithoutLine, []);
  assert.deepEqual(report.linesWithoutStage, []);
  assert.deepEqual(report.countMismatches, []);
  assert.deepEqual(report.privacyViolations, []);
  assert.deepEqual(report.defects, []);
});

test('a stage with no log line is named, not counted as agreement', async () => {
  const run = await runFor('drill-run-log-005');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest).filter(
    (line) => line.module !== 'planning',
  );
  const report = reconcileShadowRunLogs([run], lines);

  assert.equal(report.reconciled, false);
  assert.equal(report.matchedPairs, 7);
  assert.deepEqual(
    report.stagesWithoutLine.map((pair) => pair.module),
    ['planning'],
  );
  assert.deepEqual(report.linesWithoutStage, []);
});

test('a log line about a stage the trace does not have is named by the contract too', async () => {
  const run = await runFor('drill-run-log-006');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const trimmedTrace = { ...run.trace, stages: run.trace.stages.filter((stage) => stage.module !== 'memory') };
  const report = reconcileShadowRunLogs([{ ...run, trace: trimmedTrace }], lines);

  assert.equal(report.reconciled, false);
  assert.deepEqual(
    report.linesWithoutStage.map((pair) => pair.module),
    ['memory'],
  );
  assert.ok(
    report.defects.some((defect) => defect.code === 'LOG_STAGE_NOT_IN_TRACE'),
    'the contract checker must see it as well',
  );
});

test('a duplicated line for one stage fails even though every id still matches', async () => {
  const run = await runFor('drill-run-log-007');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const planning = lines.find((line) => line.module === 'planning');
  assert.ok(planning);
  const withDuplicate = [...lines, planning];
  const report = reconcileShadowRunLogs([run], withDuplicate);

  assert.equal(report.reconciled, false);
  assert.equal(report.logPairs, 9);
  assert.deepEqual(
    report.countMismatches.map((pair) => [pair.module, pair.traceCount, pair.logCount]),
    [['planning', 1, 2]],
  );
  assert.equal(
    setBasedAgreement([run], withDuplicate),
    true,
    'the set-based comparison this reconciler replaces would have called it perfect',
  );
});

test('a duplicate in one run and an absence in another cancel out only for a set', async () => {
  const first = await runFor('drill-run-log-008');
  const second = await runFor('drill-run-log-009');
  const firstLines = emitShadowRunLog(first.trace, first.bundleDigest);
  const secondLines = emitShadowRunLog(second.trace, second.bundleDigest);

  const firstPlanning = firstLines.find((line) => line.module === 'planning');
  assert.ok(firstPlanning);
  const skewed = [
    ...firstLines,
    firstPlanning,
    ...secondLines.filter((line) => line.module !== 'planning'),
  ];

  const report = reconcileShadowRunLogs([first, second], skewed);
  assert.equal(report.reconciled, false);
  assert.equal(report.tracePairs, 16);
  assert.equal(report.logPairs, 16, 'the totals agree exactly, which is why totals are not the check');
  assert.deepEqual(
    report.countMismatches.map((pair) => [pair.runId, pair.module, pair.traceCount, pair.logCount]),
    [['drill-run-log-008', 'planning', 1, 2]],
  );
  assert.deepEqual(
    report.stagesWithoutLine.map((pair) => [pair.runId, pair.module]),
    [['drill-run-log-009', 'planning']],
  );
  assert.equal(
    setBasedAgreement([first, second], skewed),
    true,
    'this is the Sprint 08 shape: deduplicated ids agree while the readers disagree',
  );
});

test('a line naming a run the batch does not contain is unattributed, not matched', async () => {
  const run = await runFor('drill-run-log-010');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const foreign = { ...lines[3], runId: 'drill-run-elsewhere' };
  const report = reconcileShadowRunLogs([run], [...lines, foreign]);

  assert.equal(report.reconciled, false);
  assert.deepEqual(
    report.unattributedLines.map((item) => item.runId),
    ['drill-run-elsewhere'],
  );
  assert.equal(report.matchedPairs, 8);
});

test('a line whose digest is another run is refused despite the shared identifier', async () => {
  const run = await runFor('drill-run-log-011');
  const other = await runFor('drill-run-log-012');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const swapped = [...lines.slice(0, 4), { ...lines[4], bundleDigest: other.bundleDigest }, ...lines.slice(5)];
  const report = reconcileShadowRunLogs([run], swapped);

  assert.equal(report.reconciled, false);
  assert.ok(report.defects.some((defect) => defect.code === 'LOG_DIGEST_MISMATCH'));
});

/* ── The attack ─────────────────────────────────────────────────── */

test('every forbidden key class is refused by the shipped validator, one at a time', async () => {
  const run = await runFor('drill-run-log-013');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const stageLine = lines.find((line) => line.module === 'coaching');
  assert.ok(stageLine);

  for (const forbidden of SHADOW_FORBIDDEN_LOG_KEY_CLASSES) {
    const property = `${forbidden}Field`;
    const matchedBy = SHADOW_FORBIDDEN_LOG_KEY_CLASSES.filter(
      (candidate) => property.toLowerCase().indexOf(candidate) !== -1,
    ).length;
    assert.equal(
      matchedBy,
      1,
      `"${property}" is matched by ${matchedBy} classes — 0 means the entry is dead, more than 1 means it is masked and deletable`,
    );

    const leaky: Record<string, unknown> = { ...stageLine, [property]: 'call dr cohen about the biopsy' };
    assert.deepEqual(
      shadowLogPrivacyErrors(leaky),
      [`private property is forbidden: ${property}`],
      `the shipped validator does not refuse the "${forbidden}" class`,
    );
    const report = reconcileShadowRunLogs([run], [leaky]);
    assert.equal(report.reconciled, false);
    assert.equal(report.privacyViolations.length, 1);
    assert.equal(report.privacyViolations[0].key, property);
    assert.ok(report.defects.some((defect) => defect.code === 'LOG_CARRIES_FORBIDDEN_KEY'));
  }
});

test('the privacy gate reads the shipped validator rather than a copy of its rule', () => {
  const probe = validateAnalyticsEvent({
    version: ANALYTICS_EVENT_CONTRACT_VERSION,
    eventId: 'probe-1',
    eventName: 'capture_submitted',
    occurredAt: '2027-01-14T11:00:00.000Z',
    anonymousUserId: 'probe-user',
    cohortId: 'probe-cohort',
    experiment: null,
    consent: 'granted',
    properties: { commitmentTitle: 'x' },
  });
  assert.ok(probe.errors.includes('private property is forbidden: commitmentTitle'));
  assert.deepEqual(shadowLogPrivacyErrors({ commitmentTitle: 'x' }), [
    'private property is forbidden: commitmentTitle',
  ]);
});

test('raw content cannot ride along under an innocent key name', async () => {
  const run = await runFor('drill-run-log-014');
  const stageLine = emitShadowRunLog(run.trace, run.bundleDigest).find((line) => line.module === 'capture');
  assert.ok(stageLine);

  const nested = { ...stageLine, note: { transcript: 'she said she would call the school' } };
  assert.deepEqual(shadowLogPrivacyErrors(nested), ['property must be scalar: note']);
  assert.equal(reconcileShadowRunLogs([run], [nested]).reconciled, false);

  const overlong = { ...stageLine, label: 'a'.repeat(200) };
  assert.deepEqual(shadowLogPrivacyErrors(overlong), ['property is too long: label']);
  assert.equal(reconcileShadowRunLogs([run], [overlong]).reconciled, false);

  const short = { ...stageLine, label: 'scheduled' };
  assert.deepEqual(shadowLogPrivacyErrors(short), [], 'a short scalar under a safe name is not content');
});

test('a half-located line is refused rather than silently reconciled', async () => {
  const run = await runFor('drill-run-log-015');
  const stageLine = emitShadowRunLog(run.trace, run.bundleDigest).find((line) => line.module === 'safety');
  assert.ok(stageLine);
  const half = { ...stageLine, stagePosition: null };
  const report = reconcileShadowRunLogs([run], [half]);

  assert.equal(report.reconciled, false);
  assert.ok(report.defects.some((defect) => defect.code === 'LOG_STAGE_LOCATOR_INCOHERENT'));
});

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

/* ── What a line *says*, not merely how many there are ───────────── */

/**
 * Everything below exists because the emitter's whole output vocabulary was
 * unasserted.
 *
 * An integration review replaced every `kind` and every `occurredAt` in
 * `emitShadowRunLog` with a wrong value — `run_finished` emitted as
 * `run_started`, stage lines stamped with `startedAt` instead of `endedAt`, the
 * run's opening line stamped with the trace's closing instant — and the full
 * 3229-test suite passed on all five. `grep -rn "run_finished" tests/` returned
 * nothing at all.
 *
 * The tests that existed counted run-level lines (`runLines.length === 2`) and
 * never read one. That is the Sprint 10 "metric replaceable with a literal
 * constant" shape applied to an emitter: the module's own header calls the kind
 * vocabulary closed because "'the run started' and 'the run finished' are the
 * two lines an operator looks for first", and it could have stopped producing
 * either.
 */

test('the run-level lines are one opening and one closing, in that order', async () => {
  const run = await runFor('drill-run-log-kinds');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const runLevel = lines.filter((line) => line.module === null);

  assert.deepEqual(
    runLevel.map((line) => line.kind),
    ['run_started', 'run_finished'],
    'the two lines an operator looks for first are not the two lines emitted',
  );
  // Positional, not just present: an operator scanning a merged log reads order.
  assert.equal(lines[0].kind, 'run_started');
  assert.equal(lines[lines.length - 1].kind, 'run_finished');
});

test('every stage line is a stage_recorded, and no stage line claims a run kind', async () => {
  const run = await runFor('drill-run-log-stagekind');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const stageLines = lines.filter((line) => line.module !== null);

  assert.equal(stageLines.length, run.trace.stages.length);
  for (const line of stageLines) {
    assert.equal(line.kind, 'stage_recorded', `a stage line was emitted as ${line.kind}`);
  }
  // And the converse: a run-level kind never carries a module.
  for (const line of lines) {
    if (line.kind === 'stage_recorded') assert.notEqual(line.module, null);
    else assert.equal(line.module, null, `${line.kind} carried a module`);
  }
});

test('each line is stamped with the instant it is about, not merely with some instant', async () => {
  // The three stamps are three different values in a real trace, so a fixture
  // where they coincided would make any of these assertions vacuous. Checked
  // first, then asserted.
  const run = await runFor('drill-run-log-instants');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  const stages = run.trace.stages;
  assert.ok(stages.length > 0, 'no stages, so nothing below asserts anything');

  const opening = stages[0].startedAt;
  const closing = run.trace.recordedAt;
  assert.notEqual(opening, closing, 'the fixture opens and closes at one instant; the stamps cannot be told apart');

  assert.equal(lines[0].occurredAt, opening, 'the opening line is not stamped with the first stage’s start');
  assert.equal(lines[lines.length - 1].occurredAt, closing, 'the closing line is not stamped with the trace’s record instant');

  // Stage lines carry the instant the stage *ended*. A stage whose start and end
  // differ is what separates that from `startedAt`; assert at least one exists
  // before relying on the comparison.
  const movingStages = stages.filter((stage) => stage.startedAt !== stage.endedAt);
  assert.ok(movingStages.length > 0, 'every stage started and ended at one instant; endedAt is untestable here');
  for (const stage of stages) {
    const line = lines.find((entry) => entry.module === stage.module);
    assert.ok(line, `no line for ${stage.module}`);
    assert.equal(
      line?.occurredAt,
      stage.endedAt,
      `${stage.module}'s line is stamped with something other than the instant the stage ended`,
    );
  }
});

test('the log’s instants are non-decreasing, so a merged operator view reads in order', async () => {
  const run = await runFor('drill-run-log-order');
  const lines = emitShadowRunLog(run.trace, run.bundleDigest);
  for (let index = 1; index < lines.length; index += 1) {
    assert.ok(
      Date.parse(lines[index].occurredAt) >= Date.parse(lines[index - 1].occurredAt),
      `line ${index} (${lines[index].kind}) is stamped before line ${index - 1} (${lines[index - 1].kind})`,
    );
  }
});

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
    // `includes`, not `deepEqual`: the gate now reports two independent reasons
    // for a stray key — the shipped validator's name verdict, which is what this
    // test is about, and the closed-vocabulary refusal added beside it. Pinning
    // the exact list would make this test about the second reason too, and it
    // would then pass if the validator stopped being consulted at all.
    assert.ok(
      shadowLogPrivacyErrors(leaky).includes(`private property is forbidden: ${property}`),
      `the shipped validator does not refuse the "${forbidden}" class`,
    );
    const report = reconcileShadowRunLogs([run], [leaky]);
    assert.equal(report.reconciled, false);
    // One offending key, two reasons: the forbidden name and the closed
    // vocabulary. Counted by distinct key, because that is what a reader acts on.
    assert.deepEqual(
      Array.from(new Set(report.privacyViolations.map((violation) => violation.key))),
      [property],
    );
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
  assert.ok(
    shadowLogPrivacyErrors({ commitmentTitle: 'x' }).includes(
      'private property is forbidden: commitmentTitle',
    ),
    'the gate no longer reports the shipped validator’s own verdict',
  );
});

test('raw content cannot ride along under an innocent key name', async () => {
  // This test used to end by asserting that a *short scalar under a safe name*
  // produced no error, on the reasoning that only long or structured values can
  // be content. That was the hole, not the rule: an integration review put
  //
  //     properties.note = "relapsed tuesday, has not told wife, clinic on Elm St 4pm"
  //
  // — 56 characters, scalar, innocuous key — through the gate and got an empty
  // error list and `reconciled: true`. The module header had claimed the
  // value-shaped verdicts closed exactly that case. They do not; a closed key
  // vocabulary does.
  const run = await runFor('drill-run-log-014');
  const stageLine = emitShadowRunLog(run.trace, run.bundleDigest).find((line) => line.module === 'capture');
  assert.ok(stageLine);

  const nested = { ...stageLine, note: { transcript: 'she said she would call the school' } };
  assert.ok(shadowLogPrivacyErrors(nested).includes('property must be scalar: note'));
  assert.equal(reconcileShadowRunLogs([run], [nested]).reconciled, false);

  const overlong = { ...stageLine, label: 'a'.repeat(200) };
  assert.ok(shadowLogPrivacyErrors(overlong).includes('property is too long: label'));
  assert.equal(reconcileShadowRunLogs([run], [overlong]).reconciled, false);

  // The reviewer's line, verbatim, and the shape the header always claimed to
  // catch. Refused for the reason that actually applies: `note` is not a field
  // a shadow log line has.
  const sentence = { ...stageLine, note: 'relapsed tuesday, has not told wife, clinic on Elm St 4pm' };
  assert.ok(
    shadowLogPrivacyErrors(sentence).includes('key is not part of the shadow log vocabulary: note'),
    'a short scalar sentence under an innocuous key still passes the gate',
  );
  assert.equal(reconcileShadowRunLogs([run], [sentence]).reconciled, false);

  // And a stray key is refused whatever it holds — the closure is about the key.
  const harmless = { ...stageLine, label: 'scheduled' };
  assert.ok(shadowLogPrivacyErrors(harmless).includes('key is not part of the shadow log vocabulary: label'));

  // The other direction: every key the line is *supposed* to carry passes, or
  // the gate would refuse every real line and no emitter could satisfy it.
  assert.deepEqual(shadowLogPrivacyErrors(stageLine), []);
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

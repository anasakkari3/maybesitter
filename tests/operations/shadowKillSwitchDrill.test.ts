/**
 * #46, acceptance criterion "kill switches are tested" — exercised, not
 * documented.
 *
 * The sweep flips **one** switch at a time and runs a whole fixture pipeline
 * under it. Flipping them together would prove that some switch is wired, which
 * is the result a suite gets when seven of eight switches are dead: every
 * assertion still passes because the eighth one did the work. So each case
 * asserts two things about the rest of the chain as well — that no other
 * module's stage names a switch, and that every other module still executed the
 * model path it was allowed to.
 *
 * "The run degrades to the documented stance" needs the stance to be documented
 * somewhere a test can read, and `SHADOW_KILL_SWITCH_STANCE` is that. It is not
 * uniform: `priority` is a placeholder, so there is no rules-only mode for it to
 * fall back into and the honest record is `skipped`. A test that expected
 * `fell_back` everywhere would have forced the fixture to lie about the one
 * module in the chain that has nothing behind it.
 *
 * Every run in the sweep is put through `checkShadowPipelineOutcome` and
 * `checkShadowTrace` before anything is concluded from it. A degraded run that
 * is also malformed proves nothing about degradation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_MODULE_FAILURE_STANCE,
  SHADOW_MODULE_ROLES,
  SHADOW_PIPELINE_CHAIN,
  checkShadowPipelineOutcome,
  checkShadowTrace,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { resolveModuleRuntime, readRuntimeControls } from '../../src/contracts/v1/runtimeControls.ts';
import {
  SHADOW_KILL_SWITCH_STANCE,
  killSwitchEnvKey,
  runShadowDrill,
  shadowDrillEnv,
} from '../../lib/operations/shadowDrillPipeline.ts';
import {
  expectedStatusForStance,
  shadowKillSwitchCasePassed,
  sweepShadowKillSwitches,
  type ShadowKillSwitchCase,
} from '../../lib/operations/shadowKillSwitchDrill.ts';

const STARTED_AT = '2027-01-14T11:00:00.000Z';

test('the baseline run throws no switch and executes every implemented module', async () => {
  const result = await runShadowDrill({
    runId: 'drill-baseline',
    scopeId: 'drill-scope',
    startedAt: STARTED_AT,
    env: shadowDrillEnv(),
  });

  assert.deepEqual(checkShadowPipelineOutcome(result.bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
  for (const stage of result.bundle.trace.stages) {
    assert.notEqual(stage.reason, 'kill_switch_active', `${stage.module} names a switch nobody threw`);
    assert.equal(stage.runtimeDecision.mode, 'enabled', stage.module);
  }
  for (const invocation of result.invocations) {
    assert.equal(
      invocation.modelExecuted,
      SHADOW_MODULE_ROLES[invocation.module] === 'implemented',
      `${invocation.module} did not take the path its role allows`,
    );
  }
  assert.equal(result.bundle.outcome.completeness, 'degraded');
  assert.equal(result.bundle.outcome.deliverable !== null, true);
});

test('every module in the chain degrades to its documented stance when its switch is thrown', async () => {
  const cases = await sweepShadowKillSwitches({ startedAt: STARTED_AT });
  assert.equal(cases.length, SHADOW_PIPELINE_CHAIN.length);
  assert.equal(cases.length, 8);

  for (const drillCase of cases) {
    const label = drillCase.module;
    assert.deepEqual(drillCase.outcomeDefects, [], `${label}: the outcome is malformed`);
    assert.deepEqual(drillCase.traceDefects, [], `${label}: the trace is malformed`);

    assert.equal(drillCase.runtimeMode, 'rules_only', `${label}: the switch did not reach the runtime decision`);
    assert.equal(drillCase.runtimeReason, 'kill_switch_active', label);
    assert.equal(drillCase.switchVisibleInTrace, true, `${label}: the switch is invisible in the trace`);
    assert.equal(drillCase.observedReason, 'kill_switch_active', label);
    assert.equal(
      drillCase.observedStatus,
      expectedStatusForStance(SHADOW_KILL_SWITCH_STANCE[drillCase.module]),
      `${label}: the run did not degrade to its documented stance`,
    );
    assert.equal(drillCase.modelExecuted, false, `${label}: the model path ran under a thrown switch`);
    assert.deepEqual(
      [...drillCase.otherModulesAffected],
      [],
      `${label}: throwing one switch changed another module's stage`,
    );
    assert.equal(drillCase.passed, true, label);
  }
});

test('the sweep covers the chain exactly once, in chain order', async () => {
  const cases = await sweepShadowKillSwitches({ startedAt: STARTED_AT });
  assert.deepEqual(
    cases.map((drillCase) => drillCase.module),
    [...SHADOW_PIPELINE_CHAIN],
  );
});

test('the placeholder module is skipped rather than falling back to a stub', async () => {
  const cases = await sweepShadowKillSwitches({ startedAt: STARTED_AT });
  const priority = cases.find((drillCase) => drillCase.module === 'priority');
  assert.ok(priority);
  assert.equal(SHADOW_MODULE_ROLES.priority, 'placeholder');
  assert.equal(SHADOW_KILL_SWITCH_STANCE.priority, 'skipped_no_fallback');
  assert.equal(priority.observedStatus, 'skipped');
  assert.equal(
    priority.observedReason,
    'kill_switch_active',
    'the operator action is the fact that explains this run; "always a stub" explains every run',
  );
  assert.equal(priority.contributed, false);
});

test('a rules-only fallback still contributes, so the gate is not starved by its own switch', async () => {
  const cases = await sweepShadowKillSwitches({ startedAt: STARTED_AT });
  const safety = cases.find((drillCase) => drillCase.module === 'safety');
  assert.ok(safety);
  assert.equal(SHADOW_MODULE_FAILURE_STANCE.safety, 'fail_closed');
  assert.equal(safety.observedStatus, 'fell_back');
  assert.equal(safety.contributed, true);
  assert.equal(
    safety.completeness,
    'degraded',
    'a rules-only gate answered; the withheld path is the gate not answering at all',
  );
});

test('a gate that does not answer at all withholds the run', async () => {
  const result = await runShadowDrill({
    runId: 'drill-gate-failure',
    scopeId: 'drill-scope',
    startedAt: STARTED_AT,
    env: shadowDrillEnv(),
    behaviours: { safety: { kind: 'errors', failureCode: 'INTERNAL_ERROR' } },
  });

  assert.deepEqual(checkShadowPipelineOutcome(result.bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
  assert.equal(result.bundle.outcome.completeness, 'withheld');
  assert.equal(result.bundle.outcome.withheldReason, 'fail_closed_module_did_not_contribute');
  assert.equal(result.bundle.outcome.deliverable, null);
  assert.equal(result.bundle.outcome.degradation?.crossedFailClosedModule, true);
});

test('the kill switch outranks the feature flag, and the trace says which one it was', async () => {
  const env = shadowDrillEnv({
    MAYBESITTER_FEATURE_COACHING: 'true',
    [killSwitchEnvKey('coaching')]: 'true',
  });
  const controls = readRuntimeControls(env);
  assert.equal(controls.featureFlags.coaching, true);
  assert.equal(controls.killSwitches.coaching, true);

  const decision = resolveModuleRuntime('coaching', controls);
  assert.equal(decision.mode, 'rules_only');
  assert.equal(decision.mode === 'rules_only' ? decision.reason : null, 'kill_switch_active');

  const result = await runShadowDrill({
    runId: 'drill-precedence',
    scopeId: 'drill-scope',
    startedAt: STARTED_AT,
    env,
  });
  const stage = result.bundle.trace.stages.find((candidate) => candidate.module === 'coaching');
  assert.ok(stage);
  assert.equal(stage.reason, 'kill_switch_active');
  assert.notEqual(stage.reason, 'feature_disabled');
});

test('a feature flag turned off is a different reason from a switch thrown', async () => {
  const result = await runShadowDrill({
    runId: 'drill-flag-off',
    scopeId: 'drill-scope',
    startedAt: STARTED_AT,
    env: shadowDrillEnv({ MAYBESITTER_FEATURE_PLANNING: 'false' }),
  });
  const stage = result.bundle.trace.stages.find((candidate) => candidate.module === 'planning');
  assert.ok(stage);
  assert.equal(stage.reason, 'feature_disabled');
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
});

test('every clause of the case verdict is load-bearing on its own', async () => {
  const cases = await sweepShadowKillSwitches({ startedAt: STARTED_AT });
  const clean = cases.find((drillCase) => drillCase.module === 'coaching');
  assert.ok(clean);
  const observed: Omit<ShadowKillSwitchCase, 'passed'> = { ...clean };
  assert.equal(shadowKillSwitchCasePassed(observed), true);

  const mutants: readonly [string, Omit<ShadowKillSwitchCase, 'passed'>][] = [
    ['the switch never reached the runtime decision', { ...observed, runtimeMode: 'enabled' }],
    ['the runtime decision blamed something else', { ...observed, runtimeReason: 'feature_disabled' }],
    ['the switch is invisible in the trace', { ...observed, switchVisibleInTrace: false }],
    ['the stage blamed something else', { ...observed, observedReason: 'module_error' }],
    ['the module did not degrade to its stance', { ...observed, observedStatus: 'completed' }],
    ['the adapter reached the model anyway', { ...observed, modelExecuted: true }],
    ['another module moved too', { ...observed, otherModulesAffected: ['planning'] }],
    [
      'the outcome is malformed',
      {
        ...observed,
        outcomeDefects: [
          {
            code: 'RUN_ID_UNSAFE',
            module: null,
            stagePosition: null,
            proposalIndex: null,
            evidenceIndex: null,
            pillar: null,
            limitName: null,
            detail: 'injected',
          },
        ],
      },
    ],
    [
      'the trace is malformed',
      {
        ...observed,
        traceDefects: [
          {
            code: 'TRACE_STAGE_MISSING',
            module: null,
            stagePosition: null,
            proposalIndex: null,
            evidenceIndex: null,
            pillar: null,
            limitName: null,
            detail: 'injected',
          },
        ],
      },
    ],
  ];

  for (const [label, mutant] of mutants) {
    assert.equal(
      shadowKillSwitchCasePassed(mutant),
      false,
      `a case where ${label} still reported a pass`,
    );
  }
});

test('a switch left off changes nothing, so the sweep is measuring the flip', async () => {
  const cases = await sweepShadowKillSwitches({ startedAt: STARTED_AT, throwSwitch: false });
  for (const drillCase of cases) {
    assert.equal(drillCase.runtimeMode, 'enabled', drillCase.module);
    assert.equal(drillCase.switchVisibleInTrace, false, drillCase.module);
    assert.equal(
      drillCase.passed,
      false,
      `${drillCase.module}: a case with no switch thrown must not report a pass`,
    );
  }
});

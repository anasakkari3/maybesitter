/**
 * The harness every other #46 test rests on.
 *
 * A drill that measured malformed runs would measure nothing, so the fixture
 * pipeline is held to the same three checkers the real orchestrator will be —
 * outcome, trace, and replay — and to determinism: same plan, byte-identical
 * bundle digest. The elapsed table is pinned against literals *and* against the
 * contract's budgets, because a fixture stage that quietly exceeded its budget
 * would be rejected as `TRACE_COMPLETED_EXCEEDS_BUDGET` and every measurement
 * taken over it would be a measurement of a rejected run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_TOTAL_BUDGET_MS,
  checkShadowInertness,
  checkShadowPipelineOutcome,
  checkShadowReplay,
  checkShadowTrace,
  shadowReplayPreimage,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  SHADOW_DRILL_ELAPSED_MS,
  SHADOW_DRILL_HARD_DEPENDENCY,
  runShadowDrill,
  shadowDrillEnv,
} from '../../lib/operations/shadowDrillPipeline.ts';
import {
  SYNTHETIC_PLACEHOLDER_DRILL_PROFILE,
  SYNTHETIC_PLACEHOLDER_MODULE,
  SYNTHETIC_PLACEHOLDER_ROLES,
} from '../fixtures/shadowSyntheticPlaceholder.ts';

const PLAN = {
  runId: 'drill-harness-001',
  scopeId: 'drill-scope',
  startedAt: '2027-01-14T09:00:00.000Z',
  env: shadowDrillEnv(),
};

test('the fixture elapsed table is pinned and sits inside every declared budget', () => {
  assert.deepEqual(
    { ...SHADOW_DRILL_ELAPSED_MS },
    {
      capture: 750,
      memory: 200,
      // 0 while priority was a placeholder, which is never invoked and so never
      // spends time. #131 made it execute: half its 250 budget, like every
      // other row here.
      priority: 125,
      decomposition: 600,
      planning: 450,
      recommendation: 400,
      coaching: 750,
      safety: 300,
    },
  );
  for (const module of SHADOW_PIPELINE_CHAIN) {
    assert.ok(
      SHADOW_DRILL_ELAPSED_MS[module] < SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
      `${module}: the fixture takes at least as long as its budget, so a completed stage would be rejected`,
    );
  }
  let total = 0;
  for (const module of SHADOW_PIPELINE_CHAIN) total += SHADOW_DRILL_ELAPSED_MS[module];
  // 3450 + priority's 125 (#131).
  assert.equal(total, 3575);
  assert.ok(total < SHADOW_PIPELINE_TOTAL_BUDGET_MS);
});

test('a fixture run is contract-clean, inert, and replays to itself', async () => {
  const result = await runShadowDrill(PLAN);
  assert.deepEqual(checkShadowPipelineOutcome(result.bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
  assert.deepEqual(checkShadowInertness(result.bundle.outcome), []);
  assert.deepEqual(
    checkShadowReplay(result.bundle, {
      outcome: result.bundle.outcome,
      trace: result.bundle.trace,
      controls: result.controls,
      bundleDigest: result.bundle.bundleDigest,
    }),
    [],
  );
  assert.equal(result.bundle.outcome.totalElapsedMs, 3575);
  // Every module contributed, so the fixture reports `complete`. It threw here
  // instead while priority was a placeholder, because no run could then be
  // complete and a harness that produced one would have been manufacturing it.
  assert.equal(result.bundle.outcome.completeness, 'complete');
  assert.equal(result.bundle.outcome.degradation, null);
});

test('a placeholder in the drill is skipped, reaches no model, and degrades the run', async () => {
  // The drill's own placeholder branch, which every drill run exercised while
  // priority was the placeholder and none does with the real roles since #131.
  const result = await runShadowDrill({
    ...PLAN,
    runId: 'drill-harness-placeholder',
    profile: SYNTHETIC_PLACEHOLDER_DRILL_PROFILE,
  });
  const outcome = result.bundle.outcome;
  assert.deepEqual(checkShadowPipelineOutcome(outcome, SYNTHETIC_PLACEHOLDER_ROLES), []);
  assert.deepEqual(checkShadowTrace(result.bundle.trace, outcome), []);

  const stub = outcome.moduleOutcomes[SYNTHETIC_PLACEHOLDER_MODULE];
  assert.equal(stub.status, 'skipped');
  assert.equal(stub.reason, 'module_placeholder');
  assert.equal(stub.elapsedMs, 0);
  const invocation = result.invocations.find((entry) => entry.module === SYNTHETIC_PLACEHOLDER_MODULE);
  assert.ok(invocation);
  assert.equal(invocation.modelExecuted, false, 'a placeholder reached a model');
  assert.equal(outcome.completeness, 'degraded');
  assert.deepEqual(outcome.degradation?.nonContributingModules, [SYNTHETIC_PLACEHOLDER_MODULE]);
  assert.equal(outcome.totalElapsedMs, 3575 - SHADOW_DRILL_ELAPSED_MS[SYNTHETIC_PLACEHOLDER_MODULE]);
});

test('the same plan produces a byte-identical preimage and digest', async () => {
  const first = await runShadowDrill(PLAN);
  const second = await runShadowDrill(PLAN);
  assert.equal(shadowReplayPreimage(first.bundle), shadowReplayPreimage(second.bundle));
  assert.equal(first.bundle.bundleDigest, second.bundle.bundleDigest);
  assert.notEqual(first.bundle.bundleDigest, '');
});

test('a different plan produces a different digest, so the digest is reading the run', async () => {
  const first = await runShadowDrill(PLAN);
  const slower = await runShadowDrill({ ...PLAN, behaviours: { memory: { kind: 'times_out' } } });
  assert.notEqual(first.bundle.bundleDigest, slower.bundle.bundleDigest);
});

test('a lost hard dependency skips its dependant for upstream_did_not_contribute', async () => {
  assert.equal(SHADOW_DRILL_HARD_DEPENDENCY.decomposition, 'capture');
  const result = await runShadowDrill({
    ...PLAN,
    runId: 'drill-harness-002',
    behaviours: { capture: { kind: 'errors', failureCode: 'UPSTREAM_UNAVAILABLE' } },
  });

  assert.deepEqual(checkShadowPipelineOutcome(result.bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
  const decomposition = result.bundle.trace.stages.find((stage) => stage.module === 'decomposition');
  assert.ok(decomposition);
  assert.equal(decomposition.status, 'skipped');
  assert.equal(decomposition.reason, 'upstream_did_not_contribute');
  assert.equal(
    result.invocations.some((invocation) => invocation.module === 'decomposition'),
    false,
    'a module with nothing to act on is not called at all',
  );
  const planning = result.bundle.trace.stages.find((stage) => stage.module === 'planning');
  assert.ok(planning);
  assert.equal(planning.status, 'completed', 'degrade_open means the chain continues past a loss');
});

test('a timed-out stage is judged against the budget it broke', async () => {
  const result = await runShadowDrill({
    ...PLAN,
    runId: 'drill-harness-003',
    behaviours: { recommendation: { kind: 'times_out' } },
  });
  const stage = result.bundle.trace.stages.find((candidate) => candidate.module === 'recommendation');
  assert.ok(stage);
  assert.equal(stage.status, 'timed_out');
  assert.equal(stage.reason, 'budget_exhausted');
  assert.equal(stage.elapsedMs, SHADOW_MODULE_TIMEOUT_BUDGET_MS.recommendation);
  assert.deepEqual(checkShadowTrace(result.bundle.trace, result.bundle.outcome), []);
});

test('a run at shadow_only claims no exposure and attaches to no session', async () => {
  const result = await runShadowDrill(PLAN);
  assert.equal(result.bundle.input.exposure.stage, 'shadow_only');
  assert.equal(result.bundle.input.exposure.allowed, false);
  assert.equal(result.bundle.input.exposure.reason, 'stage_is_shadow_only');
  assert.equal(result.bundle.trace.alphaSessionId, null);
  assert.equal(result.bundle.outcome.deliverable?.wouldHaveBeenShown, false);
});

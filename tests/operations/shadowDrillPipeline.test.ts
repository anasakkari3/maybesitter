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
      priority: 0,
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
  assert.equal(total, 3450);
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
  assert.equal(result.bundle.outcome.totalElapsedMs, 3450);
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

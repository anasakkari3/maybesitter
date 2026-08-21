/**
 * The shadow orchestrator: the chain, the trace, the budgets, and degradation.
 *
 * Every test here is written against the contract's own checkers rather than
 * against a hand-copied expectation of what a good bundle looks like. That is
 * deliberate and it is the point of having shipped the contract first: if the
 * orchestrator produces a bundle that `checkShadowPipelineOutcome`,
 * `checkShadowTrace` or `checkShadowReplay` reports anything about, this suite
 * fails — so the orchestrator cannot drift from the artifact three tracks are
 * built on without someone noticing here.
 *
 * The acceptance criteria and where they live:
 *
 *  - "a trace explains each downstream decision" → `the trace explains every
 *    module the outcome decided about` and the degradation sweep, both of which
 *    assert `checkShadowTrace(...)` is empty across every shape the pipeline can
 *    produce. An unexplained decision is a finding by construction.
 *  - "one module failure degrades safely" → `degradation sweep`, which forces
 *    each of the eight modules to fail in turn.
 *  - "shadow results cannot mutate canonical state" → the type half is the
 *    contract's; the runtime half is `checkShadowInertness` over the emitted
 *    bundle here, and the import-closure half is
 *    `shadowPipelineBoundaries.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_MODULE_FAILURE_STANCE,
  SHADOW_MODULE_ROLES,
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_PIPELINE_CHAIN_POSITION,
  checkShadowInertness,
  checkShadowPipelineOutcome,
  checkShadowReplay,
  checkShadowTrace,
  nonContributingModules,
  shadowReplayPreimage,
  type ShadowModuleAdapter,
  type ShadowPipelineModule,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import {
  SHADOW_MODULE_PREREQUISITES,
  createShadowPipelineRun,
} from '../../lib/shadowPipeline/orchestrator.ts';
import { createShadowRunLedger } from '../../lib/shadowPipeline/ports.ts';
import {
  RUN_ID,
  createTestClock,
  createTestDeadline,
  createTestDigest,
  stubAdapters,
  testControls,
  testInput,
} from './harness.ts';

/** One run with fully controllable ports. Fresh ledger per run, always. */
async function runWith(options: {
  readonly adapters?: Record<ShadowPipelineModule, ShadowModuleAdapter>;
  readonly script?: Parameters<typeof createTestDeadline>[0]['script'];
  readonly elapsedFor?: (module: ShadowPipelineModule) => number;
  readonly input?: Parameters<typeof testInput>[0];
} = {}) {
  const clock = createTestClock();
  const deadline = createTestDeadline({
    clock,
    script: options.script,
    elapsedFor: options.elapsedFor,
  });
  const digest = createTestDigest();
  const ledger = createShadowRunLedger();
  const run = createShadowPipelineRun({ clock, deadline, digest, ledger });
  const bundle = await run(testInput(options.input), options.adapters ?? stubAdapters());
  return { bundle, clock, deadline, digest, ledger };
}

/* ── The chain runs, and what it emits satisfies its own contract ─── */

test('a clean run emits a bundle its own checkers report nothing about', async () => {
  const { bundle } = await runWith();
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
  assert.deepEqual(checkShadowInertness(bundle.outcome), []);
  assert.equal(bundle.runId, RUN_ID);
});

test('the chain is walked in declared order, once per module', async () => {
  const invoked: ShadowPipelineModule[] = [];
  await runWith({ adapters: stubAdapters({ onInvoke: (module) => invoked.push(module) }) });
  // `priority` is a placeholder in the registry, so its adapter is never called
  // at all — the honest handling, and the reason this is not simply the chain.
  assert.deepEqual(
    invoked,
    SHADOW_PIPELINE_CHAIN.filter((module) => SHADOW_MODULE_ROLES[module] !== 'placeholder'),
  );
});

test('no run is ever complete, because the chain contains a placeholder', async () => {
  // The consequence the contract states rather than discovers: `priority` is
  // `not_implemented_in_sprint_00` in `INTELLIGENCE_MODULE_CONTRACTS`, a
  // placeholder can never report `completed`, so `degraded` is the ceiling for
  // this sprint.
  //
  // This comment used to end "if someone implements priority and updates the
  // registry, this test fails and the update becomes a decision rather than a
  // drift". That was false, and integration proved it by doing exactly that:
  // the registry entry was corrected and **nothing failed here**, because the
  // orchestrator reads `SHADOW_MODULE_ROLES` — a second, hand-maintained copy
  // of the same fact — and not the registry.
  //
  // The check that comment described now exists, as
  // `tests/shadowPipeline/registryDrift.test.ts`, and it does fail on that
  // mutation. This test asserts the behaviour that follows from the role table;
  // that one asserts the role table still means what the registry says.
  const { bundle } = await runWith();
  assert.equal(bundle.outcome.completeness, 'degraded');
  assert.deepEqual(nonContributingModules(bundle.outcome), ['priority']);
  const priority = bundle.outcome.moduleOutcomes.priority;
  assert.equal(priority.status, 'skipped');
  assert.equal(priority.reason, 'module_placeholder');
});

test('the trace explains every module the outcome decided about', async () => {
  const { bundle } = await runWith();
  const traced = bundle.trace.stages.map((stage) => stage.module);
  assert.deepEqual(traced, [...SHADOW_PIPELINE_CHAIN]);
  for (const stage of bundle.trace.stages) {
    assert.equal(stage.position, SHADOW_PIPELINE_CHAIN_POSITION[stage.module]);
    assert.equal(stage.status, bundle.outcome.moduleOutcomes[stage.module].status);
    if (stage.status !== 'completed') {
      assert.notEqual(stage.reason, null, `${stage.module} did not complete and states no reason`);
    }
    assert.equal(stage.runtimeDecision.module, stage.module);
  }
});

test('the carried duration is the measured one, not what the adapter claimed', async () => {
  // The stub adapters all report `elapsedMs: 0`. The orchestrator owns the
  // clock and must overwrite that, or `TRACE_ELAPSED_DISAGREES_WITH_INTERVAL`
  // would fire on every run — which is exactly why the contract carries the
  // duration rather than deriving it.
  const { bundle } = await runWith({ elapsedFor: (module) => (module === 'planning' ? 37 : 5) });
  assert.equal(bundle.outcome.moduleOutcomes.planning.elapsedMs, 37);
  const planningStage = bundle.trace.stages.find((stage) => stage.module === 'planning');
  assert.equal(planningStage?.elapsedMs, 37);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Budgets: declared, per module, and actually handed to the race ── */

test('every module is raced against its own declared budget', async () => {
  const { deadline } = await runWith();
  const raced = new Map(deadline.budgets());
  for (const module of SHADOW_PIPELINE_CHAIN) {
    if (SHADOW_MODULE_ROLES[module] === 'placeholder') {
      assert.equal(raced.has(module), false, `${module} is a placeholder and must not be raced`);
      continue;
    }
    assert.equal(
      raced.get(module),
      SHADOW_MODULE_TIMEOUT_BUDGET_MS[module],
      `${module} was raced against a budget that is not its declared one`,
    );
  }
});

test('the adapter is told the same budget the race was given', async () => {
  // Two places could disagree — the value handed to `deadline.race` and the one
  // put on the invocation — and a module that self-limits against a different
  // number than the orchestrator enforces is a timeout nobody can review.
  const told = new Map<ShadowPipelineModule, number>();
  const { deadline } = await runWith({
    adapters: stubAdapters({ onInvoke: (module, budgetMs) => told.set(module, budgetMs) }),
  });
  for (const entry of deadline.budgets()) {
    assert.equal(told.get(entry[0]), entry[1], `${entry[0]} was told a different budget than was enforced`);
  }
});

test('a module abandoned at its budget is timed_out with budget_exhausted', async () => {
  const { bundle } = await runWith({ script: { memory: 'timeout' } });
  const memory = bundle.outcome.moduleOutcomes.memory;
  assert.equal(memory.status, 'timed_out');
  assert.equal(memory.reason, 'budget_exhausted');
  assert.equal(memory.contributed, false);
  assert.equal(memory.elapsedMs, SHADOW_MODULE_TIMEOUT_BUDGET_MS.memory);
  // And the artifact still satisfies its own checkers, including the
  // budget-reachability rules on both sides.
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('an answer that arrives after the deadline is not accepted as an answer', async () => {
  // A real timer settles some microseconds either side of the line. Accepting a
  // value that arrived past the budget would emit a `completed` stage whose
  // elapsed exceeds its budget — a bundle that fails its own checker in
  // production and nowhere else. The orchestrator reports the budget as
  // exhausted, because it was.
  const { bundle } = await runWith({
    elapsedFor: (module) => (module === 'planning' ? SHADOW_MODULE_TIMEOUT_BUDGET_MS.planning + 1 : 5),
  });
  const planning = bundle.outcome.moduleOutcomes.planning;
  assert.equal(planning.status, 'timed_out');
  assert.equal(planning.reason, 'budget_exhausted');
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('an answer that arrives exactly at the budget is accepted', async () => {
  // The other side of the late-answer guard. Without this, `>` and `>=` are
  // indistinguishable and the boundary is whichever one someone typed —
  // mutation testing found exactly that survivor.
  const { bundle } = await runWith({
    elapsedFor: (module) =>
      module === 'planning' ? SHADOW_MODULE_TIMEOUT_BUDGET_MS.planning : 5,
  });
  const planning = bundle.outcome.moduleOutcomes.planning;
  assert.equal(planning.status, 'completed', 'a module that finished exactly on its budget was abandoned');
  assert.equal(planning.elapsedMs, SHADOW_MODULE_TIMEOUT_BUDGET_MS.planning);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── The ledger's own bounds ─────────────────────────────────────── */

test('rolling the proposal ledger back is bounded at both ends', async () => {
  const ledger = createShadowRunLedger();
  const proposal = (module: ShadowPipelineModule) =>
    ({
      status: 'proposed_never_applied',
      proposedBy: module,
      target: 'plan_store',
      kind: 'schedule',
      payloadDigest: 'deadbeefdeadbeef',
    }) as const;
  ledger.propose(proposal('capture'));
  ledger.propose(proposal('planning'));

  // Past the end is a no-op, not a truncation to a longer array.
  ledger.rollbackProposals(5);
  assert.equal(ledger.proposals().length, 2);
  // Negative is a no-op, not a RangeError from `recorded.length = -1`.
  ledger.rollbackProposals(-1);
  assert.equal(ledger.proposals().length, 2);
  // And the real case still works.
  ledger.rollbackProposals(1);
  assert.deepEqual(ledger.proposals().map((entry) => entry.proposedBy), ['capture']);
});

/* ── Runtime controls: the switches runtimeControls already owns ──── */

test('a kill switch turns a module into a fell_back stage that still contributes', async () => {
  const { bundle } = await runWith({
    input: { controls: testControls({ killSwitches: { planning: true } }) },
  });
  const planning = bundle.outcome.moduleOutcomes.planning;
  assert.equal(planning.status, 'fell_back');
  assert.equal(planning.reason, 'kill_switch_active');
  assert.equal(planning.contributed, true);
  // Contributing is the point: a kill switch that made every downstream module
  // skip would be a kill switch nobody dares use.
  assert.deepEqual(nonContributingModules(bundle.outcome), ['priority']);
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('a disabled feature flag is reported as feature_disabled, not as a failure', async () => {
  const { bundle } = await runWith({
    input: { controls: testControls({ featureFlags: { memory: false } }) },
  });
  const memory = bundle.outcome.moduleOutcomes.memory;
  assert.equal(memory.status, 'fell_back');
  assert.equal(memory.reason, 'feature_disabled');
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('the stage reason and the runtime decision it came from cannot disagree', async () => {
  const { bundle } = await runWith({
    input: { controls: testControls({ killSwitches: { coaching: true } }) },
  });
  const stage = bundle.trace.stages.find((candidate) => candidate.module === 'coaching');
  assert.equal(stage?.runtimeDecision.mode, 'rules_only');
  assert.equal(stage?.reason, 'kill_switch_active');
  // `TRACE_FALLBACK_CONTRADICTS_RUNTIME_DECISION` is what would fire.
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('a module that answers under a rules-only decision may not claim full completion', async () => {
  // The stub reports `completed`; the runtime decision restricted it. The
  // orchestrator records what the runtime permitted, not what the adapter
  // claimed, because the contract treats the pair as a contradiction.
  const { bundle } = await runWith({
    input: { controls: testControls({ featureFlags: { decomposition: false } }) },
  });
  assert.equal(bundle.outcome.moduleOutcomes.decomposition.status, 'fell_back');
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Prerequisites and the cascade ───────────────────────────────── */

test('the prerequisite table is total and acyclic within the declared chain order', async () => {
  for (const module of SHADOW_PIPELINE_CHAIN) {
    const prerequisites = SHADOW_MODULE_PREREQUISITES[module];
    assert.ok(prerequisites !== undefined, `${module} has no prerequisite entry`);
    for (const prerequisite of prerequisites) {
      assert.ok(
        SHADOW_PIPELINE_CHAIN.includes(prerequisite),
        `${module} requires ${prerequisite}, which is not in the chain`,
      );
      assert.ok(
        SHADOW_PIPELINE_CHAIN_POSITION[prerequisite] < SHADOW_PIPELINE_CHAIN_POSITION[module],
        `${module} requires ${prerequisite}, which runs after it`,
      );
    }
  }
});

test('a module whose prerequisite did not contribute is skipped, and says which', async () => {
  const { bundle } = await runWith({ adapters: stubAdapters({ throwing: ['recommendation'] }) });
  const coaching = bundle.outcome.moduleOutcomes.coaching;
  assert.equal(coaching.status, 'skipped');
  assert.equal(coaching.reason, 'upstream_did_not_contribute');
  const recommendation = bundle.outcome.moduleOutcomes.recommendation;
  assert.equal(recommendation.status, 'unavailable');
  assert.equal(recommendation.reason, 'module_error');
  assert.equal(recommendation.failureCode, 'INTERNAL_ERROR');
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Degradation: one module failing leaves a usable result ──────── */

test('degradation sweep: every module can fail and the pipeline still answers', async () => {
  for (const failing of SHADOW_PIPELINE_CHAIN) {
    if (SHADOW_MODULE_ROLES[failing] === 'placeholder') continue;

    const { bundle } = await runWith({ adapters: stubAdapters({ throwing: [failing] }) });
    const outcome = bundle.outcome;
    const missing = nonContributingModules(outcome);

    // Whatever failed, the artifact is well-formed and fully explained.
    assert.deepEqual(
      checkShadowPipelineOutcome(outcome),
      [],
      `${failing} failing produced an outcome its own checker reports`,
    );
    assert.deepEqual(
      checkShadowTrace(bundle.trace, outcome),
      [],
      `${failing} failing produced a trace that does not explain the outcome`,
    );

    // The module that failed is a non-contributor, and so is everything that
    // needed it — nothing else.
    assert.ok(missing.includes(failing), `${failing} failed and is not listed as a non-contributor`);
    assert.ok(missing.includes('priority'), 'the placeholder is always a non-contributor');

    const safetyContributed = outcome.moduleOutcomes.safety.contributed;
    if (safetyContributed) {
      // Degrade-open: a usable deliverable survives.
      assert.equal(outcome.completeness, 'degraded', `${failing} failing should degrade, not withhold`);
      assert.notEqual(outcome.deliverable, null, `${failing} failing left no usable result`);
    } else {
      // Fail-closed: the guard did not run, so nothing may be delivered.
      assert.equal(outcome.completeness, 'withheld', `${failing} failing should withhold`);
      assert.equal(outcome.deliverable, null);
      assert.equal(outcome.withheldReason, 'fail_closed_module_did_not_contribute');
      assert.equal(outcome.degradation.crossedFailClosedModule, true);
    }
  }
});

test('safety failing withholds rather than degrades', async () => {
  // The named case from the sweep, asserted on its own so a change to the
  // sweep's structure cannot quietly stop covering it.
  assert.equal(SHADOW_MODULE_FAILURE_STANCE.safety, 'fail_closed');
  const { bundle } = await runWith({ adapters: stubAdapters({ throwing: ['safety'] }) });
  assert.equal(bundle.outcome.completeness, 'withheld');
  assert.equal(bundle.outcome.deliverable, null);
  assert.equal(bundle.outcome.withheldReason, 'fail_closed_module_did_not_contribute');
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('a degrade-open module failing leaves the deliverable intact', async () => {
  const { bundle } = await runWith({ adapters: stubAdapters({ throwing: ['memory'] }) });
  assert.equal(bundle.outcome.completeness, 'degraded');
  assert.notEqual(bundle.outcome.deliverable, null);
  assert.deepEqual(nonContributingModules(bundle.outcome), ['memory', 'priority']);
  assert.equal(bundle.outcome.degradation.crossedFailClosedModule, false);
});

test('capture failing cascades to the guard, and the run withholds', async () => {
  const { bundle } = await runWith({ adapters: stubAdapters({ throwing: ['capture'] }) });
  assert.equal(bundle.outcome.completeness, 'withheld');

  // `memory` is deliberately not downstream of capture — retrieval for a scope
  // does not depend on what this run's text turned out to say — so it still
  // contributes. That is the table doing its job, not a gap: coupling them
  // would make a capture failure cost context it never needed.
  assert.equal(bundle.outcome.moduleOutcomes.memory.status, 'completed');

  // Everything that genuinely depended on capture explains itself as an
  // upstream failure, which is what makes a cascade readable rather than a wall
  // of unexplained skips.
  for (const module of SHADOW_PIPELINE_CHAIN) {
    if (module === 'capture' || module === 'memory') continue;
    if (SHADOW_MODULE_ROLES[module] === 'placeholder') continue;
    assert.equal(
      bundle.outcome.moduleOutcomes[module].reason,
      'upstream_did_not_contribute',
      `${module} did not explain itself as an upstream failure`,
    );
  }
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Determinism and inertness of the emitted artifact ───────────── */

test('two runs over one input produce byte-identical bundles', async () => {
  const first = await runWith();
  const second = await runWith();
  assert.deepEqual(first.bundle, second.bundle);
  assert.equal(
    shadowReplayPreimage(first.bundle),
    shadowReplayPreimage(second.bundle),
    'the same input produced two different preimages',
  );
});

test('nothing callable is reachable from the emitted bundle', async () => {
  // The type half of "shadow results cannot mutate canonical state" is the
  // contract's; this is the runtime half over a real emitted artifact, and the
  // import-closure half is in shadowPipelineBoundaries.test.ts.
  const { bundle } = await runWith();
  assert.deepEqual(checkShadowInertness(bundle), []);
});

test('the ledger is cleared per run, so a run cannot inherit earlier proposals', async () => {
  const ledger = createShadowRunLedger();
  const clock = createTestClock();
  const deadline = createTestDeadline({ clock });
  const run = createShadowPipelineRun({ clock, deadline, digest: createTestDigest(), ledger });

  ledger.propose({
    status: 'proposed_never_applied',
    proposedBy: 'planning',
    target: 'plan_store',
    kind: 'schedule',
    payloadDigest: 'deadbeefdeadbeef',
  });
  const bundle = await run(testInput(), stubAdapters());
  assert.deepEqual(
    bundle.outcome.deliverable === null ? [] : bundle.outcome.deliverable.proposedEffects,
    [],
    'a proposal from before the run survived into the run',
  );
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Replay ──────────────────────────────────────────────────────── */

test('the bundle digest is computed over the contract preimage and nothing else', async () => {
  const { bundle, digest } = await runWith();
  const preimages = digest.preimages();
  assert.ok(
    preimages.includes(shadowReplayPreimage(bundle)),
    'the digest port was never handed the preimage the contract defines',
  );
  assert.equal(bundle.bundleDigest, createTestDigest().hash(shadowReplayPreimage(bundle)));
});

test('an identical replay reports nothing, and a divergent one is detected and localised', async () => {
  const recorded = await runWith();
  const replayed = await runWith();
  assert.deepEqual(
    checkShadowReplay(recorded.bundle, {
      outcome: replayed.bundle.outcome,
      trace: replayed.bundle.trace,
      controls: replayed.bundle.input.controls,
      bundleDigest: replayed.bundle.bundleDigest,
    }),
    [],
  );

  const diverged = await runWith({ script: { planning: 'timeout' } });
  const findings = checkShadowReplay(recorded.bundle, {
    outcome: diverged.bundle.outcome,
    trace: diverged.bundle.trace,
    controls: diverged.bundle.input.controls,
    bundleDigest: diverged.bundle.bundleDigest,
  });
  const codes = findings.map((finding) => finding.code);
  assert.ok(codes.includes('REPLAY_MODULE_STATUS_DIVERGED'));
  assert.ok(codes.includes('REPLAY_DIGEST_DIVERGED'));
  assert.ok(codes.includes('REPLAY_PREIMAGE_DIVERGED'));
  const localised = findings.find((finding) => finding.code === 'REPLAY_MODULE_STATUS_DIVERGED');
  assert.equal(localised?.module, 'planning');
});

test('a replay under a moved kill switch names the flag, not just a mismatch', async () => {
  const recorded = await runWith();
  const moved = await runWith({
    input: { controls: testControls({ killSwitches: { coaching: true } }) },
  });
  const codes = checkShadowReplay(recorded.bundle, {
    outcome: moved.bundle.outcome,
    trace: moved.bundle.trace,
    controls: moved.bundle.input.controls,
    bundleDigest: moved.bundle.bundleDigest,
  }).map((finding) => finding.code);
  assert.ok(codes.includes('REPLAY_CONTROLS_DIVERGED'));
});

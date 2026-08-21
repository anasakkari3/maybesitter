/**
 * The eight adapters, over the real module entry points.
 *
 * `orchestrator.test.ts` drives stub adapters on purpose, so that a failure
 * there is a failure of the chaining and a failure here is a failure of the
 * wiring. This file is the other half: it builds a genuine seed and runs the
 * whole chain through `extract`, `proposeDecomposition`, `schedulePlan`,
 * `selectRecommendation`, `planCoaching`/`realizeCoachingPlan`/`deliverCoaching`
 * and `evaluateSafetyGate`, then holds the emitted bundle against the contract's
 * own checkers.
 *
 * The memory adapter gets the most attention of any single stage here, because
 * it is the one whose registry entry point is a writer:
 * `createFileRuntimeMemoryStore` calls `writeFileSync`. The adapter takes a
 * reader instead, and `the memory adapter cannot reach a write method` proves
 * the narrowing is real rather than a naming convention — it hands the adapter
 * an object carrying every write method a `RuntimeMemoryStore` has, each of
 * which fails the test if it is ever called.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_MODULE_TIMEOUT_BUDGET_MS,
  SHADOW_PIPELINE_CHAIN,
  checkShadowInertness,
  checkShadowPipelineOutcome,
  checkShadowReplay,
  checkShadowTrace,
  nonContributingModules,
  type ShadowPipelineModule,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { createShadowAdapterSet } from '../../lib/shadowPipeline/adapters.ts';
import { canonicalize, type ShadowMemoryReader, type ShadowRunSeed } from '../../lib/shadowPipeline/seed.ts';
import { createShadowPipelineRun } from '../../lib/shadowPipeline/orchestrator.ts';
import { createShadowRunLedger } from '../../lib/shadowPipeline/ports.ts';
import { createSha256ShadowDigest } from '../../lib/shadowPipeline/realtime.ts';
import type { Field, LifeState } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { PriorityScore } from '../../src/contracts/v1/priorityContracts.ts';
import type { RuntimeMemoryRecord } from '../../src/contracts/v1/memoryContracts.ts';
import type { CommitmentSnapshot } from '../../lib/recommendation/selector/candidates.ts';
import type { ExtractionResult } from '../../src/extraction/extractionTypes.ts';
import {
  createTestClock,
  createTestDeadline,
  createTestDigest,
  testControls,
  testInput,
} from './harness.ts';

const NOW = '2027-01-05T09:00:00.000Z';
const COMPUTED_AT = '2027-01-05T08:30:00.000Z';

function knownField<T>(value: T): Field<T> {
  return {
    known: true,
    value,
    provenance: { source: 'domain_state', derivedFrom: COMPUTED_AT, computedAt: COMPUTED_AT },
  };
}

function unknownField<T>(): Field<T> {
  return {
    known: false,
    reason: 'NO_DATA',
    provenance: { source: 'absent', derivedFrom: null, computedAt: COMPUTED_AT },
  };
}

function lifeState(): LifeState {
  return {
    version: 'life-state-v1',
    scopeId: 'scope-a',
    computedAt: COMPUTED_AT,
    inputDigest: 'life-state-digest',
    commitments: knownField({
      countsByStatus: { active: 2 },
      openCount: 2,
      overdueCount: 1,
      openCommitmentIds: ['c-alpha', 'c-bravo'],
      overdueCommitmentIds: ['c-alpha'],
    }),
    availability: unknownField(),
    load: knownField({
      totalUrgencyScore: 12,
      openCount: 2,
      overdueCount: 1,
      dueSoonCount: 1,
      band: 'moderate',
    }),
    recentOutcomes: unknownField(),
  };
}

function commitment(commitmentId: string, overrides: Partial<CommitmentSnapshot> = {}): CommitmentSnapshot {
  return {
    commitmentId,
    status: 'active',
    confirmedAt: '2027-01-04T09:00:00.000Z',
    dueAt: null,
    remindAt: null,
    importance: null,
    blockedByCommitmentIds: [],
    planItemId: null,
    decompositionProposalId: null,
    decompositionStepId: null,
    ...overrides,
  };
}

function score(commitmentId: string, total: number): PriorityScore {
  return {
    version: 'priority-v1',
    commitmentId,
    total,
    components: [{ code: 'reason_base', points: total, evidence: null }],
    reasonCodes: [],
    policyVersion: 'policy-v1',
  };
}

function seed(overrides: Partial<ShadowRunSeed> = {}): ShadowRunSeed {
  return {
    scopeId: 'scope-a',
    now: NOW,
    timezone: 'Asia/Jerusalem',
    captureText: 'Call the clinic tomorrow at 10am to book the follow-up',
    lifeState: lifeState(),
    commitments: [
      commitment('c-alpha', { dueAt: '2027-01-05T17:00:00.000Z', importance: 'high' }),
      commitment('c-bravo'),
    ],
    priorityScores: [score('c-alpha', 40), score('c-bravo', 10)],
    horizon: { startsAt: NOW, endsAt: '2027-01-06T09:00:00.000Z' },
    workingWindows: [
      { windowId: 'w-tue', weekday: 2, startMinute: 540, endMinute: 1020, timezone: 'Asia/Jerusalem' },
      { windowId: 'w-wed', weekday: 3, startMinute: 540, endMinute: 1020, timezone: 'Asia/Jerusalem' },
    ],
    fixedEvents: [],
    planningItems: [
      {
        itemId: 'item-alpha',
        title: 'Call the clinic',
        effort: { kind: 'known', minutes: 30 },
        earliestStartAt: null,
        deadlineAt: null,
        priority: 1,
        dependsOn: [],
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
      },
    ],
    planningConfig: { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false },
    pressureBudget: {
      maxIntensity: 'low',
      minIntervalMinutes: 60,
      lastPressuredAt: null,
      consecutiveUnansweredCount: 0,
      maxConsecutiveUnanswered: 3,
    },
    permittedSensitivity: 'personal',
    attestedDecisions: [],
    ...overrides,
  };
}

/** A reader with nothing on it but `retrieve`. */
function emptyReader(records: readonly RuntimeMemoryRecord[] = []): ShadowMemoryReader & {
  queries(): readonly unknown[];
} {
  const queries: unknown[] = [];
  return {
    retrieve(query) {
      queries.push(query);
      return records;
    },
    queries: () => queries.slice(),
  };
}

async function runRealChain(options: {
  readonly seed?: ShadowRunSeed;
  readonly memory?: ShadowMemoryReader;
  readonly controls?: ReturnType<typeof testControls>;
} = {}) {
  const clock = createTestClock(NOW);
  const deadline = createTestDeadline({ clock });
  const digest = createTestDigest();
  const ledger = createShadowRunLedger();
  const controls = options.controls ?? testControls();
  const adapters = createShadowAdapterSet({
    seed: options.seed ?? seed(),
    ledger,
    digest,
    memory: options.memory ?? emptyReader(),
  });
  const run = createShadowPipelineRun({ clock, deadline, digest, ledger });
  const bundle = await run(testInput({ controls }), adapters);
  return { bundle, ledger, adapters, digest };
}

/* ── The whole chain, over the real modules ──────────────────────── */

test('the real chain runs end to end and emits a bundle its checkers report nothing about', async () => {
  const { bundle } = await runRealChain();
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
  assert.deepEqual(checkShadowInertness(bundle), []);
});

test('every implemented module contributes, and only the placeholder does not', async () => {
  const { bundle } = await runRealChain();
  assert.deepEqual(
    nonContributingModules(bundle.outcome),
    ['priority'],
    'a real module failed to contribute over a valid seed',
  );
  assert.equal(bundle.outcome.completeness, 'degraded');
  assert.notEqual(bundle.outcome.deliverable, null);
});

test('every contributing stage carries a real digest of a real payload', async () => {
  const { bundle, ledger } = await runRealChain();
  const digest = createTestDigest();
  for (const module of SHADOW_PIPELINE_CHAIN) {
    const outcome = bundle.outcome.moduleOutcomes[module];
    if (!outcome.contributed) continue;
    const payload = ledger.readPayload(module);
    assert.notEqual(payload, null, `${module} contributed without recording a payload`);
    assert.equal(
      outcome.outputDigest,
      digest.hash(canonicalize(payload)),
      `${module}'s digest is not a digest of the payload it recorded`,
    );
  }
});

/* ── Capture: bound to the deterministic extractor ───────────────── */

test('capture binds to the rule-based extractor, not to a service that writes', async () => {
  const { ledger } = await runRealChain();
  const captured = ledger.readPayload('capture') as ExtractionResult;
  // Shape assertions rather than an identity check: these fields exist because
  // `ruleBasedExtractor` produced them, and no other capture path in this repo
  // returns a `parserVersion`.
  assert.equal(typeof captured.parserVersion, 'string');
  assert.equal(captured.rawText, seed().captureText);
  assert.ok(['task', 'follow_up', 'informational_context', 'unknown'].includes(captured.type));
});

test('capture proposes a commitment it never creates', async () => {
  const { bundle } = await runRealChain();
  const proposals = bundle.outcome.deliverable?.proposedEffects ?? [];
  const fromCapture = proposals.filter((proposal) => proposal.proposedBy === 'capture');
  assert.ok(fromCapture.length > 0, 'capture found a commitment and proposed nothing');
  for (const proposal of fromCapture) {
    assert.equal(proposal.status, 'proposed_never_applied');
    assert.equal(proposal.target, 'commitment_store');
    assert.equal(proposal.kind, 'create');
  }
});

test('a capture that finds nothing proposes nothing, and the chain still answers', async () => {
  // Whitespace, not `'...'`. The first draft used `'...'` and the guard below
  // caught it: `ruleBasedExtractor` reads `'...'` as a task titled `'...'`, so
  // the fixture never reached the branch it was named for.
  const { bundle, ledger } = await runRealChain({ seed: seed({ captureText: '   ' }) });
  const captured = ledger.readPayload('capture') as ExtractionResult;
  assert.equal(
    (captured.title ?? '').trim(),
    '',
    'the "found nothing" fixture produced a real extraction; it is not exercising the branch',
  );
  const proposals = bundle.outcome.deliverable?.proposedEffects ?? [];
  assert.deepEqual(
    proposals.filter((proposal) => proposal.proposedBy === 'capture'),
    [],
    'capture found nothing and proposed something anyway',
  );
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
  assert.notEqual(bundle.outcome.deliverable, null);
});

/* ── Memory: the narrowing is the mechanism ──────────────────────── */

test('the memory adapter cannot reach a write method', async () => {
  // The adapter's declared dependency is `retrieve` and nothing else. This
  // hands it an object that also carries every write method a
  // `RuntimeMemoryStore` has — the registry's named entry point returns one of
  // those — and fails if any is called. A naming convention would pass a test
  // that only checked the adapter's parameter name; this checks behaviour.
  const forbidden: string[] = [];
  const trap = (name: string) => () => {
    forbidden.push(name);
    throw new Error(`the shadow memory adapter called ${name}`);
  };
  const reader = {
    retrieve: () => [] as readonly RuntimeMemoryRecord[],
    put: trap('put'),
    supersede: trap('supersede'),
    revoke: trap('revoke'),
    deleteById: trap('deleteById'),
    deleteScope: trap('deleteScope'),
    prune: trap('prune'),
    get: trap('get'),
    listAll: trap('listAll'),
    export: trap('export'),
  };

  const { bundle } = await runRealChain({ memory: reader as unknown as ShadowMemoryReader });
  assert.deepEqual(forbidden, [], 'the shadow memory adapter reached a method that is not a read');
  assert.equal(bundle.outcome.moduleOutcomes.memory.status, 'completed');
});

test('the memory retrieval is scoped and carries the seed instant, never a clock read', async () => {
  const reader = emptyReader();
  await runRealChain({ memory: reader });
  assert.deepEqual(reader.queries(), [{ scopeId: 'scope-a', now: NOW }]);
});

/* ── Priority: the placeholder is refused, not stubbed ───────────── */

test('the priority adapter refuses to be invoked, and the orchestrator never invokes it', async () => {
  const { bundle, adapters } = await runRealChain();
  assert.equal(bundle.outcome.moduleOutcomes.priority.reason, 'module_placeholder');

  // Called directly, it throws. If someone removes the orchestrator's
  // placeholder skip, the stage becomes `unavailable` and loudly wrong rather
  // than a plausible stub answer counted as a contribution.
  await assert.rejects(
    () =>
      adapters.priority({
        module: 'priority',
        runId: 'run-x',
        scopeId: 'scope-a',
        startedAt: NOW,
        budgetMs: 250,
        runtimeDecision: { version: 'v1', module: 'priority', mode: 'enabled', allowsModelExecution: true },
      }),
    /placeholder/,
  );
});

test('decomposition takes the deterministic path, and its provenance says so', async () => {
  // A shadow run must not reach a model provider it was not given.
  // `requestedEngine` travels into the proposal's provenance, so this is the
  // engine's own record of which path ran rather than this test's belief.
  const { ledger } = await runRealChain();
  const proposal = ledger.readPayload('decomposition') as {
    provenance: { requestedEngine: string; executedEngine: string; fallbackUsed: boolean };
  };
  assert.equal(proposal.provenance.requestedEngine, 'rules');
  assert.equal(proposal.provenance.executedEngine, 'rules');
  assert.equal(proposal.provenance.fallbackUsed, false, 'the rules path was reached by falling back to it');
});

/* ── Decomposition: the same controls the trace recorded ─────────── */

test('a kill switch reaches the module that resolves its own runtime decision', async () => {
  // `proposeDecomposition` calls `resolveModuleRuntime` internally. Handing it
  // a different snapshot than the orchestrator resolved from would let the
  // stage and the module disagree about whether a switch was thrown — the stage
  // would say `enabled` while the engine ran rules-only.
  const controls = testControls({ killSwitches: { decomposition: true } });
  const { bundle } = await runRealChain({ controls });
  const stage = bundle.trace.stages.find((candidate) => candidate.module === 'decomposition');
  assert.equal(stage?.runtimeDecision.mode, 'rules_only');
  assert.equal(bundle.outcome.moduleOutcomes.decomposition.status, 'fell_back');
  assert.equal(bundle.outcome.moduleOutcomes.decomposition.reason, 'kill_switch_active');
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Safety with nothing to judge ────────────────────────────────── */

test('the safety adapter with no candidate skips naming its upstream, and does not throw', async () => {
  // Driven directly rather than through a seed contrived to make coaching
  // refuse: a fixture that only *sometimes* reaches the branch is a fixture
  // that sometimes tests nothing. An empty ledger is the branch, exactly.
  const ledger = createShadowRunLedger();
  const adapters = createShadowAdapterSet({
    seed: seed(),
    ledger,
    digest: createTestDigest(),
    memory: emptyReader(),
  });

  const outcome = await adapters.safety({
    module: 'safety',
    runId: 'run-x',
    scopeId: 'scope-a',
    startedAt: NOW,
    budgetMs: 600,
    runtimeDecision: { version: 'v1', module: 'safety', mode: 'enabled', allowsModelExecution: true },
  });

  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'upstream_did_not_contribute');
  assert.equal(outcome.contributed, false);
  assert.equal(outcome.outputDigest, null);
});

/* ── Proposals are attributed to the stage that made them ────────── */

test('every proposal is attributed to a contributing module and explained by its stage', async () => {
  const { bundle } = await runRealChain();
  const proposals = bundle.outcome.deliverable?.proposedEffects ?? [];
  assert.ok(proposals.length >= 2, 'the real chain proposed almost nothing; the fixture is not exercising it');

  for (let index = 0; index < proposals.length; index += 1) {
    const proposal = proposals[index];
    const stage = bundle.trace.stages.find((candidate) => candidate.module === proposal.proposedBy);
    assert.ok(
      stage?.proposalIndices.includes(index),
      `proposal ${index} is attributed to ${proposal.proposedBy}, whose stage does not claim it`,
    );
    assert.equal(bundle.outcome.moduleOutcomes[proposal.proposedBy].contributed, true);
  }
  // And the checker agrees, which is the assertion that would catch an
  // attribution this test's own loop happened to construct consistently.
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Degradation over the real adapter set ───────────────────────── */

test('degradation sweep over the real adapters: one failing module still answers', async () => {
  // `orchestrator.test.ts` sweeps the same ground with stubs, which proves the
  // chaining. This sweeps it with the real adapter set in place and one adapter
  // replaced, which proves the *composition* survives: real payloads flow up to
  // the break, and everything downstream of it explains itself.
  for (const failing of SHADOW_PIPELINE_CHAIN) {
    if (failing === 'priority') continue;

    const clock = createTestClock(NOW);
    const deadline = createTestDeadline({ clock });
    const digest = createTestDigest();
    const ledger = createShadowRunLedger();
    const controls = testControls();
    const adapters = createShadowAdapterSet({
      seed: seed(),
      ledger,
      digest,
      memory: emptyReader(),
    });
    const broken = {
      ...adapters,
      [failing]: async () => {
        throw new Error(`forced failure in ${failing}`);
      },
    } as typeof adapters;

    const bundle = await createShadowPipelineRun({ clock, deadline, digest, ledger })(
      testInput({ controls }),
      broken,
    );

    assert.deepEqual(
      checkShadowPipelineOutcome(bundle.outcome),
      [],
      `${failing} failing produced an outcome its own checker reports`,
    );
    assert.deepEqual(
      checkShadowTrace(bundle.trace, bundle.outcome),
      [],
      `${failing} failing produced a trace that does not explain the outcome`,
    );
    assert.ok(
      nonContributingModules(bundle.outcome).includes(failing),
      `${failing} failed and is not listed as a non-contributor`,
    );

    if (bundle.outcome.moduleOutcomes.safety.contributed) {
      assert.equal(bundle.outcome.completeness, 'degraded');
      assert.notEqual(bundle.outcome.deliverable, null, `${failing} failing left no usable result`);
    } else {
      assert.equal(bundle.outcome.completeness, 'withheld');
      assert.equal(bundle.outcome.deliverable, null);
    }
  }
});

test('a coaching refusal withholds rather than degrades, and says why', async () => {
  // The path a real refusal takes: coaching answers, produces no candidate, and
  // the safety stage skips naming its upstream. Forced here by a seed whose
  // recommendation cannot be spoken about — no commitments at all — so this is
  // the real modules refusing, not a stub pretending to.
  const { bundle } = await runRealChain({
    seed: seed({ commitments: [], priorityScores: [] }),
  });
  const safety = bundle.outcome.moduleOutcomes.safety;
  if (safety.contributed) return; // The selector still found something to say.
  assert.equal(safety.status, 'skipped');
  assert.equal(safety.reason, 'upstream_did_not_contribute');
  assert.equal(bundle.outcome.completeness, 'withheld');
  assert.equal(bundle.outcome.withheldReason, 'fail_closed_module_did_not_contribute');
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

test('a module that proposed and then lost its budget keeps no proposal', async () => {
  // The reachable shape of the rollback: `planning` proposes its plan and then
  // the orchestrator finds the answer arrived past the budget, so the stage is
  // `timed_out` and did not contribute. Without the rollback the proposal
  // survives into the deliverable attributed to a module the outcome says
  // produced nothing — `PROPOSAL_FROM_NON_CONTRIBUTING_MODULE` — and the stage
  // records still cite positions that have shifted underneath them.
  const clock = createTestClock(NOW);
  const deadline = createTestDeadline({
    clock,
    elapsedFor: (module) =>
      module === 'planning' ? SHADOW_MODULE_TIMEOUT_BUDGET_MS.planning + 1 : 1,
  });
  const digest = createTestDigest();
  const ledger = createShadowRunLedger();
  const controls = testControls();
  const adapters = createShadowAdapterSet({ seed: seed(), ledger, digest, memory: emptyReader() });
  const bundle = await createShadowPipelineRun({ clock, deadline, digest, ledger })(
    testInput({ controls }),
    adapters,
  );

  const planning = bundle.outcome.moduleOutcomes.planning;
  assert.equal(planning.status, 'timed_out', 'the fixture did not reach the branch it is named for');
  assert.equal(planning.contributed, false);

  const proposals = bundle.outcome.deliverable?.proposedEffects ?? [];
  assert.deepEqual(
    proposals.filter((proposal) => proposal.proposedBy === 'planning'),
    [],
    'a module that did not contribute left a proposal behind',
  );
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
});

/* ── Determinism and replay over the real chain ──────────────────── */

test('two runs of the real chain over one seed agree byte for byte', async () => {
  const first = await runRealChain();
  const second = await runRealChain();
  assert.deepEqual(first.bundle, second.bundle);
});

test('a different capture text produces a different bundle digest', async () => {
  // Otherwise the digest is a constant and every replay assertion is vacuous.
  const first = await runRealChain();
  const second = await runRealChain({
    seed: seed({ captureText: 'Email the landlord about the boiler on Thursday' }),
  });
  assert.notEqual(first.bundle.bundleDigest, second.bundle.bundleDigest);

  const findings = checkShadowReplay(first.bundle, {
    outcome: second.bundle.outcome,
    trace: second.bundle.trace,
    controls: second.bundle.input.controls,
    bundleDigest: second.bundle.bundleDigest,
  });
  assert.ok(findings.map((finding) => finding.code).includes('REPLAY_DIGEST_DIVERGED'));
});

/* ── Canonicalisation, which every payload digest rests on ───────── */

test('canonicalisation is key-order independent, so a digest is about content', async () => {
  const left = { beta: 1, alpha: [1, 2, { zulu: true, alpha: null }] };
  const right = { alpha: [1, 2, { alpha: null, zulu: true }], beta: 1 };
  assert.equal(canonicalize(left), canonicalize(right));
  // Array order is data and must survive.
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]));
  // Absent and present-but-undefined must not collide with a real value.
  assert.notEqual(canonicalize({ a: undefined }), canonicalize({ a: 0 }));
  assert.equal(canonicalize({ a: undefined }), canonicalize({ a: null }));
});

test('canonicalisation survives a cycle rather than throwing', () => {
  const cyclic: Record<string, unknown> = { name: 'payload' };
  cyclic.self = cyclic;
  assert.equal(typeof canonicalize(cyclic), 'string');
});

test('a callable in a payload is not silently hashed as content', () => {
  // A function reaching a payload means a live handle reached one. Hashing its
  // source would make that fine; a fixed token makes two different functions
  // collide, which is the direction that gets noticed.
  const withFunction = canonicalize({ apply: () => 1 });
  const withOtherFunction = canonicalize({ apply: () => 2 });
  assert.equal(withFunction, withOtherFunction);
  assert.match(withFunction, /__uncanonicalizable__/);
});

test('the production digest and the canonical form agree across two shapes', () => {
  const digest = createSha256ShadowDigest();
  const a = digest.hash(canonicalize({ b: 1, a: 2 }));
  const b = digest.hash(canonicalize({ a: 2, b: 1 }));
  assert.equal(a, b);
  assert.notEqual(a, digest.hash(canonicalize({ a: 2, b: 2 })));
});

/* ── The adapter set is total ────────────────────────────────────── */

test('the adapter set covers the chain exactly', async () => {
  const { adapters } = await runRealChain();
  assert.deepEqual(Object.keys(adapters).sort(), [...SHADOW_PIPELINE_CHAIN].sort());
  for (const module of SHADOW_PIPELINE_CHAIN) {
    assert.equal(typeof adapters[module as ShadowPipelineModule], 'function');
  }
});

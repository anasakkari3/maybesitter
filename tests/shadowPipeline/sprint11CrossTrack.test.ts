/**
 * The Sprint 11 join: #45 runs the chain, #46 observes it, #47 decides on it.
 *
 * Merge-owned, because every assertion is about two tracks agreeing and no
 * track can make it about itself.
 *
 * ── Why this is not redundant with the three suites ──────────────
 *
 * Each track built against the contract's types with its own fixtures, which
 * was the right way to build them in parallel and means **none of them has run
 * against another's real output**:
 *
 *   - #46 built `createShadowDrillRun`, its own pipeline, and computed every SLO
 *     reading over that. Its own header admits the difference: "the fixture
 *     safety adapter returns a digest and not a verdict — the real one will
 *     carry `SafetyDisposition` through". So every reliability number in the
 *     sprint was measured over a pipeline that is not the pipeline.
 *   - #47's release route emits `not_available.issue_45_shadow_traces` and
 *     `not_available.issue_46_slo_readings`, and therefore always decides
 *     `hold`. Its evidence generator has never seen a real trace or a real
 *     reading.
 *
 * All three suites would stay green if #45's orchestrator produced traces #46
 * cannot read and outcomes #47 cannot score. This file is where that is checked.
 *
 * ── What is asserted as a *limitation* rather than smoothed over ──
 *
 * `priority` is a placeholder in the registry, so every Sprint 11 run is
 * `degraded` and none is ever `complete`. That is pinned here too, at the join,
 * because it is the fact that makes "the run degraded" useless as a
 * discriminating assertion — which is why #46's kill-switch sweep had to assert
 * stance, reason, runtime decision and blast radius instead. See
 * `registryDrift.test.ts` for why it was not simply fixed at integration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SHADOW_PIPELINE_CHAIN,
  SHADOW_MODULE_ROLES,
  checkShadowInertness,
  checkShadowPipelineOutcome,
  checkShadowTrace,
  contributingModules,
  nonContributingModules,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { createShadowPipelineRun } from '../../lib/shadowPipeline/orchestrator.ts';
import { createShadowRunLedger } from '../../lib/shadowPipeline/ports.ts';
import {
  RUN_ID,
  createTestClock,
  createTestDeadline,
  createTestDigest,
  stubAdapters,
  testInput,
} from './harness.ts';
import {
  emitAndReconcileShadowRunLogs,
  shadowLogPrivacyErrors,
  type ShadowLoggedRun,
} from '../../lib/operations/shadowRunLog.ts';
import { SHADOW_SLO_CATALOG } from '../../lib/operations/shadowSloCatalog.ts';
import { computeShadowSloReadings } from '../../lib/operations/shadowSloReadings.ts';
import type { ShadowRunObservation } from '../../lib/operations/shadowSloReadings.ts';
import {
  SHADOW_AUTHORISING_PROVENANCES,
  provenanceMayAuthorise,
  reliabilityPillarFromSloReadings,
  safetyPillarFromObservations,
  type ShadowEvidenceProvenance,
} from '../../lib/release/evidence.ts';

const OBSERVED_AT = '2027-01-05T10:00:00.000Z';

/**
 * A shadow run is `simulated`, never `real_exposure`.
 *
 * That is the whole reason this sprint can wire the pipeline to the evidence
 * generator without wiring a release: evidence at this provenance can refuse a
 * release and can never authorise one. Named once here so every pillar below
 * carries the same claim and none of them can quietly claim more.
 */
const SHADOW_RUN_PROVENANCE = 'simulated' as const satisfies ShadowEvidenceProvenance;

/**
 * One run of the **real orchestrator** over **stub adapters**.
 *
 * Read that precisely, because an earlier version of this file claimed more.
 * `createShadowPipelineRun` is #45's real implementation — the chain walk, the
 * runtime decisions, the timeout race, the trace assembly and the digest are
 * all the shipped code. The eight adapters are not: `stubAdapters()` returns
 * fixtures, so no real module executes and every `outputDigest` is the harness
 * constant.
 *
 * That still tests the join this file exists for. #46 reads a *trace*, and the
 * trace is produced by the real orchestrator from real runtime decisions;
 * #47 reads *readings*, which are computed from that trace. Neither reads a
 * module's payload. What it does **not** test is #45's adapter surface against
 * the other tracks, and the honest name for that is a remaining gap rather than
 * a covered one.
 *
 * Closing it means using `createShadowAdapterSet`, which needs a `ShadowRunSeed`
 * and a `ShadowMemoryReader`. Both exist, as local builders inside
 * `adapters.test.ts` alongside a `runRealChain` that already drives the real
 * adapters — so the work is to lift those builders into `harness.ts` and use
 * them from both files, not to write anything new. An independent review
 * verified the swap passes and that the two orchestrations agree in shape.
 * Deliberately not done at integration time: it is a four-function move across
 * a file this track did not write.
 */
async function realRun(runId: string = RUN_ID) {
  const clock = createTestClock();
  const deadline = createTestDeadline({ clock });
  const digest = createTestDigest();
  const ledger = createShadowRunLedger();
  const run = createShadowPipelineRun({ clock, deadline, digest, ledger });
  return run(testInput({ runId }), stubAdapters());
}

/* ── 1. #45's bundle satisfies its own contract, at the join ─────── */

test('the real orchestrator emits a bundle every contract checker accepts', async () => {
  const bundle = await realRun();
  assert.deepEqual(checkShadowPipelineOutcome(bundle.outcome), []);
  assert.deepEqual(checkShadowTrace(bundle.trace, bundle.outcome), []);
  assert.deepEqual(checkShadowInertness(bundle.outcome), []);
});

test('every Sprint 11 run is degraded and priority is the only non-contributor', async () => {
  // The limitation, pinned at the join. If the registry and the role table are
  // ever corrected together, this fails and someone re-reads the sprint's
  // reliability figures — which is the point.
  const bundle = await realRun();
  assert.equal(bundle.outcome.completeness, 'degraded');
  assert.deepEqual(nonContributingModules(bundle.outcome), ['priority']);
  assert.deepEqual(
    contributingModules(bundle.outcome).slice().sort(),
    SHADOW_PIPELINE_CHAIN.filter((m) => SHADOW_MODULE_ROLES[m] !== 'placeholder').slice().sort(),
  );
});

/* ── 2. #46 reads #45's real trace ───────────────────────────────── */

test('#46 reconciles its log lines against a real trace, at (runId, module) pairs', async () => {
  // #46's own suite reconciled against traces from `createShadowDrillRun` — its
  // own 617-line pipeline. This is the first time its emitter meets a trace
  // #45's orchestrator assembled.
  //
  // Pairs, not a set of ids: a duplicate in one run and an absence in another
  // cancel out for a set and are two separate defects for a pair count. That is
  // the Sprint 08 lesson — a set comparison reported perfect agreement while
  // the readers disagreed on 38% of inputs.
  const bundles = await Promise.all([realRun('run-x-0001'), realRun('run-x-0002')]);
  const runs: ShadowLoggedRun[] = bundles.map((bundle) => ({
    trace: bundle.trace,
    bundleDigest: bundle.bundleDigest,
  }));

  const { lines, report } = emitAndReconcileShadowRunLogs(runs);
  assert.equal(report.reconciled, true, `real traces did not reconcile: ${JSON.stringify(report).slice(0, 300)}`);
  assert.deepEqual(report.stagesWithoutLine, []);
  assert.deepEqual(report.linesWithoutStage, []);
  // The pair-count blind spot the report names in its own type: a duplicate in
  // one run and an absence in another agree as sets and differ as counts.
  assert.deepEqual(report.countMismatches, []);
  assert.deepEqual(report.privacyViolations, []);
  assert.deepEqual(report.defects, []);
  assert.equal(report.matchedPairs, report.tracePairs);
  assert.equal(report.tracePairs, report.logPairs);

  // Every stage of every real trace is accounted for, counted rather than
  // assumed — and the count is split, because the emitter's output is not one
  // line per stage. It emits two run-level lines per run with `module: null`
  // alongside the stage lines, which the reconciler correctly excludes from pair
  // matching. Asserting `lines.length === stageCount` looked right and was
  // wrong; separating the two makes the emitter's shape a pinned decision rather
  // than something a future reader has to re-derive from a mismatch.
  const stageCount = runs.reduce((total, run) => total + run.trace.stages.length, 0);
  const stageLines = lines.filter((line) => line.module !== null);
  const runLines = lines.filter((line) => line.module === null);
  assert.equal(stageLines.length, stageCount);
  assert.equal(runLines.length, runs.length * 2, 'the run-level line count per run changed');
  assert.equal(report.tracePairs, stageCount);
  assert.ok(stageCount >= SHADOW_PIPELINE_CHAIN.length, 'a real trace carried fewer stages than the chain');
});

test('no line emitted from a real trace carries anything the privacy rules forbid', async () => {
  // The trace is assembled by the real orchestrator, so this is the first time
  // the emitter meets whatever #45's trace assembly puts in a stage record —
  // the module names, positions, reasons and runtime decisions. The stage
  // *payloads* are still fixtures; see `realRun`'s header.
  const bundle = await realRun();
  const { lines } = emitAndReconcileShadowRunLogs([
    { trace: bundle.trace, bundleDigest: bundle.bundleDigest },
  ]);
  assert.ok(lines.length > 0, 'no lines emitted, so this asserted nothing');
  for (const line of lines) {
    assert.deepEqual(shadowLogPrivacyErrors(line), [], `a real-trace line was refused: ${JSON.stringify(line)}`);
  }
});

test('#46 computes readings over real runs, and the catalog is fully exercised', async () => {
  const bundle = await realRun();
  const observation: ShadowRunObservation = {
    outcome: bundle.outcome,
    trace: bundle.trace,
    costMicros: 1_000,
    replayAgreed: true,
  };
  // One run is far below every sample floor, so every reading must be
  // inconclusive — and carry no verdict, which is what stops a single run from
  // being read as a measurement.
  //
  // The shape is `value: null, breached: null`, required-and-nullable rather
  // than absent. Sprint 10 argued for omission so nothing downstream could
  // average a thin slice; here nullability is the stronger form, because the
  // union forces every consumer to narrow on `status` and `shadowSloBreached`
  // refuses a non-number outright. A null cannot become a verdict by accident
  // on either path. Asserted rather than assumed, since the two sprints made
  // different choices and a reader is owed the reason.
  const records = computeShadowSloReadings(
    { status: 'collected', observations: [observation] },
    OBSERVED_AT,
  );
  assert.equal(records.length, SHADOW_SLO_CATALOG.length);
  for (const record of records) {
    assert.equal(record.reading.status, 'inconclusive', `${record.definition.sloId} measured on one run`);
    assert.equal(record.reading.value, null);
    assert.equal(record.reading.breached, null);
  }
});

/* ── 3. #47 scores what #46 measured over what #45 ran ───────────── */

test('the reliability pillar assembles from readings taken over real runs', async () => {
  // The three-track chain in one assertion: #45's orchestrator runs, #46's
  // reader measures, #47's generator turns the measurement into evidence. Each
  // of those three is the shipped implementation; the module adapters beneath
  // them are not, per `realRun`'s header.
  const bundles = await Promise.all(
    Array.from({ length: 3 }, (_unused, index) => realRun(`run-y-000${index}`)),
  );
  const observations: ShadowRunObservation[] = bundles.map((bundle) => ({
    outcome: bundle.outcome,
    trace: bundle.trace,
    costMicros: 1_000,
    replayAgreed: true,
  }));
  const records = computeShadowSloReadings({ status: 'collected', observations }, OBSERVED_AT);

  const pillar = reliabilityPillarFromSloReadings(
    records.map((record) => record.reading),
    SHADOW_RUN_PROVENANCE,
  );

  assert.equal(pillar.findings.length, records.length);
  // Compared at (sloId, disposition) pairs. A set of dispositions would agree
  // while the readings they belong to disagreed.
  const fromReadings = records
    .map((record) => `${record.definition.sloId}=${record.reading.status === 'inconclusive' ? 'inconclusive' : record.reading.breached ? 'harm' : 'benefit'}`)
    .sort();
  const fromPillar = pillar.findings.map((finding) => `${finding.citation}=${finding.disposition}`).sort();
  assert.deepEqual(fromPillar, fromReadings);
  // Three runs is still under every floor, so nothing here may authorise.
  assert.ok(
    pillar.findings.every((finding) => finding.disposition === 'inconclusive'),
    'a pillar built from three runs claimed a measured disposition',
  );
  // And the deeper reason it may not: a shadow run is simulated, and simulated
  // evidence is not on the list a `go` may rest on. This is the property that
  // makes running the pipeline against the evidence generator safe at all.
  assert.equal(pillar.provenance, 'simulated');
  assert.ok(
    !provenanceMayAuthorise(SHADOW_RUN_PROVENANCE) &&
      !(SHADOW_AUTHORISING_PROVENANCES as readonly string[]).includes("simulated"),
    'simulated evidence became sufficient for a go; the shadow sprint can now authorise a release',
  );
});

test('the safety pillar reads a real run’s outcome, and an incident is a harm on its own', async () => {
  const bundle = await realRun();
  const withheld = bundle.outcome.completeness === 'withheld' ? 1 : 0;

  const clean = safetyPillarFromObservations(
    { runCount: 1, blockedCount: withheld, incidentCount: 0 },
    SHADOW_RUN_PROVENANCE,
  );
  assert.ok(clean.findings.every((finding) => finding.disposition !== 'harm'));

  const incident = safetyPillarFromObservations(
    { runCount: 10_000, blockedCount: withheld, incidentCount: 1 },
    SHADOW_RUN_PROVENANCE,
  );
  assert.ok(
    incident.findings.some((finding) => finding.disposition === 'harm'),
    'one incident in ten thousand runs was averaged away instead of standing as a harm',
  );
});

/* ── 4. The seam that is still open, named ───────────────────────── */

test('the release route’s two unwired pillars are exactly the two this join could fill', async () => {
  // Not an assertion that the route is wired — it is not, deliberately, since
  // wiring a file-backed store into a Next.js route is a deployment decision
  // rather than a test one. This asserts that the *reason* it is unwired is the
  // one recorded, so the gap cannot silently become a different gap.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync('src/app/api/release/route.ts', 'utf8'),
  );
  assert.match(source, /issue_45_shadow_traces/);
  assert.match(source, /issue_46_slo_readings/);
  // And both of those inputs demonstrably exist now, which is what makes the
  // gap a wiring task rather than a missing capability.
  const bundle = await realRun();
  assert.ok(bundle.trace.stages.length > 0, '#45 produces no trace to wire');
  assert.equal(SHADOW_SLO_CATALOG.length > 0, true, '#46 defines no SLO to read');
});

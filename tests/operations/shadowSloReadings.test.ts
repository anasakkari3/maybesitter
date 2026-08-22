/**
 * #46, deliverable 2: readings, and the small-sample discipline.
 *
 * The rule this file exists to hold: **under `MIN_SLO_SAMPLE_COUNT` a reading
 * carries no value at all.** Not a zero, not a null anyone can average, not a
 * number with a caveat beside it — the `inconclusive` variant, which has
 * `value: null` and `breached: null` in the type, so there is no field a
 * dashboard or an alert rule can read a measurement off. The failure this
 * prevents is a panel that renders 0% for "we have three data points" and a
 * rollback decision taken on it.
 *
 * The floor is pinned **on both sides** and its literal value is pinned
 * separately, with the probe counts written as literals rather than derived
 * from `definition.minimumSampleCount`. Sprint 10's review found every floor in
 * that sprint mutable in both directions because the fixtures were built from
 * the constant they tested; nineteen and twenty are written out below for that
 * reason, and if the floor moves these tests fail rather than following it.
 *
 * Every measurement is taken over runs from the fixture pipeline, and every
 * batch is checked against the contract's own checkers first: a timing fixture
 * whose input is rejected by an earlier bound measures nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SLO_SAMPLE_COUNT,
  SHADOW_MODULE_STATUSES,
  SHADOW_PIPELINE_CHAIN,
  SHADOW_SLO_WINDOW_MILLIS,
  checkShadowPipelineOutcome,
  checkShadowSloReading,
  checkShadowTrace,
  millisBetweenInstants,
  type Instant,
  type ShadowPipelineModule,
  type ShadowPipelineTrace,
  type ShadowSloReading,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { shadowSloById } from '../../lib/operations/shadowSloCatalog.ts';
import {
  MODULE_EXECUTION_STATUSES,
  computeShadowSloReading,
  computeShadowSloReadings,
  measureShadowSloMetric,
  shadowLatencyP95,
  shadowRunObservation,
  shadowSloWindowStart,
  type ShadowRunObservation,
} from '../../lib/operations/shadowSloReadings.ts';
import {
  killSwitchEnvKey,
  runShadowDrill,
  shadowDrillEnv,
  type ShadowDrillPlan,
} from '../../lib/operations/shadowDrillPipeline.ts';

const OBSERVED_AT: Instant = '2027-01-14T12:00:00.000Z';

function definitionFor(sloId: string) {
  const entry = shadowSloById(sloId);
  assert.ok(entry, `${sloId} is not in the catalog`);
  return entry.definition;
}

interface RunShape {
  readonly plan?: Partial<ShadowDrillPlan>;
  readonly costMicros?: number;
  readonly replayAgreed?: boolean | null;
}

/** `count` fixture runs, each with a distinct runId, checked before being measured. */
async function observations(
  count: number,
  shapeAt: (index: number) => RunShape = () => ({}),
): Promise<ShadowRunObservation[]> {
  const built: ShadowRunObservation[] = [];
  for (let index = 0; index < count; index += 1) {
    const shape = shapeAt(index);
    const result = await runShadowDrill({
      runId: `drill-run-${String(index).padStart(3, '0')}`,
      scopeId: 'drill-scope',
      startedAt: '2027-01-14T11:00:00.000Z',
      env: shadowDrillEnv(),
      costMicros: shape.costMicros ?? 0,
      ...(shape.plan ?? {}),
    });
    assert.deepEqual(checkShadowPipelineOutcome(result.bundle.outcome), [], 'fixture outcome is malformed');
    assert.deepEqual(
      checkShadowTrace(result.bundle.trace, result.bundle.outcome),
      [],
      'fixture trace is malformed',
    );
    // `??` would collapse an explicit null into true, which is the very
    // conflation `replayAgreed: null` exists to prevent.
    built.push(
      shadowRunObservation(result, shape.replayAgreed === undefined ? true : shape.replayAgreed),
    );
  }
  return built;
}

function collected(items: readonly ShadowRunObservation[]) {
  return { status: 'collected' as const, observations: items };
}

/* ── The denominator of a module-scoped rate ─────────────────────── */

/**
 * `SHADOW_SLO_SAMPLE_UNIT` calls this metric's unit `module_run`, and a module
 * that never ran is not a run.
 *
 * The first implementation incremented the denominator once per member of
 * `SHADOW_PIPELINE_CHAIN`, executed or not, and nothing tested the denominator
 * at all. Two consequences, both measured before the fix:
 *
 *   - `priority` is `skipped` in every real run, so one slot sat in the
 *     denominator the numerator could never match;
 *   - the dilution scaled with kill switches. Two modules run, both time out,
 *     six switched off — a total failure of everything that executed — read
 *     0.25 against a 0.02 threshold. The more of the pipeline you disabled, the
 *     calmer the timeout rate read, which is backwards during exactly the
 *     incident that causes switches to be pulled.
 *
 * These build outcomes directly rather than through `runShadowDrill`, because
 * the shape that matters — most of the chain switched off — is not one the
 * fixture pipeline produces.
 */
function outcomeWithStatuses(statuses: Partial<Record<ShadowPipelineModule, string>>) {
  const moduleOutcomes: Record<string, unknown> = {};
  for (const module of SHADOW_PIPELINE_CHAIN) {
    moduleOutcomes[module] = { status: statuses[module] ?? 'completed', module };
  }
  return {
    outcome: { moduleOutcomes, completeness: 'degraded', totalElapsedMs: 1, deliverable: null },
    trace: { stages: [] },
    costMicros: 0,
    replayAgreed: true,
  } as unknown as ShadowRunObservation;
}

test('a module-scoped rate divides by executions, not by chain slots', () => {
  const chain = SHADOW_PIPELINE_CHAIN;
  const mostlyOff: Partial<Record<ShadowPipelineModule, string>> = {};
  for (const module of chain.slice(2)) mostlyOff[module] = 'skipped';
  mostlyOff[chain[0]] = 'timed_out';
  mostlyOff[chain[1]] = 'timed_out';

  const measured = measureShadowSloMetric('module_timeout_rate', [outcomeWithStatuses(mostlyOff)]);
  assert.equal(measured.sampleCount, 2, 'skipped modules were counted as executions');
  assert.equal(measured.value, 1, 'everything that ran timed out and the rate did not read 1');
});

test('turning modules off cannot make a timeout rate read calmer', () => {
  // The property, stated directly: hold the failures fixed, switch more of the
  // chain off, and the rate must not fall.
  const chain = SHADOW_PIPELINE_CHAIN;
  const withSkips = (skipCount: number) => {
    const statuses: Partial<Record<ShadowPipelineModule, string>> = { [chain[0]]: 'timed_out' };
    for (const module of chain.slice(chain.length - skipCount)) statuses[module] = 'skipped';
    return measureShadowSloMetric('module_timeout_rate', [outcomeWithStatuses(statuses)]).value;
  };
  const none = withSkips(0);
  const some = withSkips(3);
  const most = withSkips(6);
  assert.ok(some >= none, `rate fell from ${none} to ${some} when three modules were switched off`);
  assert.ok(most >= some, `rate fell from ${some} to ${most} when six modules were switched off`);
});

test('the execution statuses are derived from the contract, and exclude exactly the two that never ran', () => {
  // Derived by exclusion, so a status added to the contract must be classified
  // here rather than silently counting as an execution.
  assert.deepEqual(
    SHADOW_MODULE_STATUSES.filter((status) => !MODULE_EXECUTION_STATUSES.includes(status)),
    ['skipped', 'unavailable'],
  );
  assert.deepEqual([...MODULE_EXECUTION_STATUSES], ['completed', 'fell_back', 'timed_out']);
});

test('a fallback is an attempt: it stays in the denominator of the timeout rate', () => {
  // `fell_back` is deliberately an execution. A module that fell back attempted
  // the work and could have timed out instead, so excluding it would inflate
  // the timeout rate every time the kill switches did their job.
  const chain = SHADOW_PIPELINE_CHAIN;
  const statuses: Partial<Record<ShadowPipelineModule, string>> = { [chain[0]]: 'timed_out' };
  for (const module of chain.slice(1)) statuses[module] = 'fell_back';
  const measured = measureShadowSloMetric('module_timeout_rate', [outcomeWithStatuses(statuses)]);
  assert.equal(measured.sampleCount, chain.length);
  assert.equal(measured.value, 1 / chain.length);
});

/* ── The floor, from both sides, with literal counts ─────────────── */

test('the contract floor is twenty and the reliability SLO adopts it', () => {
  assert.equal(MIN_SLO_SAMPLE_COUNT, 20);
  assert.equal(definitionFor('shadow-pipeline-withheld-rate').minimumSampleCount, 20);
});

test('nineteen runs produce an inconclusive reading with no value at all', async () => {
  const definition = definitionFor('shadow-pipeline-withheld-rate');
  const reading = computeShadowSloReading(definition, collected(await observations(19)), OBSERVED_AT);

  assert.equal(reading.status, 'inconclusive');
  assert.equal(reading.value, null);
  assert.equal(reading.breached, null);
  assert.equal(reading.inconclusiveReason, 'insufficient_sample');
  assert.equal(reading.sampleCount, 19);
  assert.deepEqual(checkShadowSloReading(reading, definition), []);
});

test('twenty runs produce a measured reading', async () => {
  const definition = definitionFor('shadow-pipeline-withheld-rate');
  const reading = computeShadowSloReading(definition, collected(await observations(20)), OBSERVED_AT);

  assert.equal(reading.status, 'measured');
  assert.equal(reading.value, 0);
  assert.equal(reading.breached, false);
  assert.equal(reading.sampleCount, 20);
  assert.equal(reading.inconclusiveReason, null);
  assert.deepEqual(checkShadowSloReading(reading, definition), []);
});

test('an empty window is no_data_in_window and an absent collector is its own reason', () => {
  const definition = definitionFor('shadow-pipeline-withheld-rate');
  const empty = computeShadowSloReading(definition, collected([]), OBSERVED_AT);
  assert.equal(empty.status, 'inconclusive');
  assert.equal(empty.inconclusiveReason, 'no_data_in_window');
  assert.equal(empty.sampleCount, 0);

  const absent = computeShadowSloReading(
    definition,
    { status: 'collector_unavailable' },
    OBSERVED_AT,
  );
  assert.equal(absent.status, 'inconclusive');
  assert.equal(absent.inconclusiveReason, 'collector_unavailable');
  assert.equal(absent.value, null);
});

test('an inconclusive reading is refused by the contract if it carries a value', () => {
  const definition = definitionFor('shadow-pipeline-withheld-rate');
  const reading = computeShadowSloReading(definition, collected([]), OBSERVED_AT);
  const smuggled = { ...reading, value: 0 } as unknown as ShadowSloReading;
  assert.deepEqual(
    checkShadowSloReading(smuggled, definition).map((defect) => defect.code),
    ['SLO_INCONCLUSIVE_NOT_VALUE_FREE'],
  );
});

/* ── The window ──────────────────────────────────────────────────── */

test('a reading spans exactly the window its definition declares', () => {
  for (const window of ['rolling_1h', 'rolling_24h', 'rolling_7d'] as const) {
    const start = shadowSloWindowStart(OBSERVED_AT, window);
    assert.equal(millisBetweenInstants(start, OBSERVED_AT), SHADOW_SLO_WINDOW_MILLIS[window]);
  }
  assert.equal(SHADOW_SLO_WINDOW_MILLIS.rolling_1h, 3600000);
  assert.equal(shadowSloWindowStart(OBSERVED_AT, 'rolling_1h'), '2027-01-14T11:00:00.000Z');
});

/* ── Per-metric measurement ──────────────────────────────────────── */

test('the withheld rate counts runs the gate never answered for', async () => {
  const definition = definitionFor('shadow-pipeline-withheld-rate');
  const items = await observations(20, (index) =>
    index < 2
      ? { plan: { behaviours: { coaching: { kind: 'errors', failureCode: 'INTERNAL_ERROR' } } } }
      : {},
  );
  const withheld = items.filter((item) => item.outcome.completeness === 'withheld');
  assert.equal(withheld.length, 2, 'a coaching failure must leave the fail_closed gate nothing to gate');

  const reading = computeShadowSloReading(definition, collected(items), OBSERVED_AT);
  assert.equal(reading.status, 'measured');
  assert.equal(reading.value, 0.1);
  assert.equal(reading.breached, true);
  assert.deepEqual(checkShadowSloReading(reading, definition), []);
});

test('the module timeout rate counts module executions, not runs', async () => {
  const definition = definitionFor('shadow-module-timeout-rate');
  const items = await observations(20, (index) =>
    index < 4 ? { plan: { behaviours: { memory: { kind: 'times_out' } } } } : {},
  );
  const reading = computeShadowSloReading(definition, collected(items), OBSERVED_AT);
  assert.equal(reading.status, 'measured');
  // 140, not 160: `priority` is a placeholder and is skipped in every run, and
  // a module that never ran is not a module run. Seven executing modules across
  // twenty runs. The literal is spelled out rather than derived from the chain
  // length so that implementing `priority` fails here and the floor beside it
  // becomes a deliberate edit.
  assert.equal(reading.sampleCount, 140, 'twenty runs of a seven-executing-module chain is 140 executions');
  // Measured, not inconclusive, even though 140 is not compared against the
  // floor: sufficiency is the twenty runs. See `Measurement.sufficiencyCount`.
  assert.equal(reading.value, 4 / 140);
  assert.equal(reading.breached, true);
});

test('nineteen runs cannot satisfy the run floor, and the reported count is still executions', async () => {
  const definition = definitionFor('shadow-module-timeout-rate');
  const reading = computeShadowSloReading(definition, collected(await observations(19)), OBSERVED_AT);
  assert.equal(reading.status, 'inconclusive');
  assert.equal(reading.inconclusiveReason, 'insufficient_sample');
  // The floor was compared against nineteen runs; the count reported to an
  // operator is what the rate would have divided by. The two are deliberately
  // different numbers and this pins both.
  assert.equal(reading.sampleCount, 133, 'nineteen runs times seven executing modules');
});

test('a degraded incident still reaches the floor: sufficiency does not shrink with failure', async () => {
  // The defect this split exists to prevent, as a test. A coaching timeout also
  // skips the fail-closed gate downstream, so a degraded run executes six
  // modules rather than seven. With sufficiency counted in executions, twenty
  // such runs produced 120 against a floor of 140 and a rate of 0.167 against a
  // 0.02 threshold read `inconclusive` — the worse the incident, the less
  // measurable it became.
  const definition = definitionFor('shadow-module-timeout-rate');
  const items = await observations(20, () => ({ plan: { behaviours: { coaching: { kind: 'times_out' } } } }));
  const reading = computeShadowSloReading(definition, collected(items), OBSERVED_AT);

  assert.equal(reading.status, 'measured', 'a severe, sustained incident reported inconclusive');
  assert.equal(reading.sampleCount, 120, 'twenty degraded runs of six executing modules');
  assert.equal(reading.breached, true);
  assert.ok((reading.value ?? 0) > definition.threshold);
});

test('the latency reading is a nearest-rank p95 over run totals', async () => {
  assert.equal(shadowLatencyP95([10]), 10);
  assert.equal(shadowLatencyP95([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 10);
  assert.equal(shadowLatencyP95([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]), 10);
  assert.equal(
    shadowLatencyP95([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9]),
    1,
    'nineteen of twenty at one: the 19th of 20 is still one',
  );
  assert.equal(
    shadowLatencyP95([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 9, 9]),
    9,
  );

  const clean = await observations(1);
  assert.equal(clean[0].outcome.totalElapsedMs, 3450);
  const slow = await observations(1, () => ({
    plan: { behaviours: { capture: { kind: 'times_out' } } },
  }));
  assert.equal(slow[0].outcome.totalElapsedMs, 3600);
});

test('the cost reading is the mean cost of a run in micros', async () => {
  const definition = definitionFor('shadow-cost-micros-per-run');
  const cheap = await observations(50, () => ({ costMicros: 2400 }));
  const cheapReading = computeShadowSloReading(definition, collected(cheap), OBSERVED_AT);
  assert.equal(cheapReading.status, 'measured');
  assert.equal(cheapReading.value, 2400);
  assert.equal(cheapReading.breached, false);

  const dear = await observations(50, (index) => ({ costMicros: index < 25 ? 3000 : 2400 }));
  const dearReading = computeShadowSloReading(definition, collected(dear), OBSERVED_AT);
  assert.equal(dearReading.status, 'measured');
  assert.equal(dearReading.value, 2700);
  assert.equal(dearReading.breached, true);
});

test('a measurement that comes out unreadable is inconclusive, not a measured NaN', async () => {
  const definition = definitionFor('shadow-cost-micros-per-run');
  const items = await observations(50, (index) => ({ costMicros: index === 7 ? Number.NaN : 2400 }));
  const reading = computeShadowSloReading(definition, collected(items), OBSERVED_AT);

  assert.equal(reading.status, 'inconclusive');
  assert.equal(
    reading.inconclusiveReason,
    'collector_unavailable',
    'a metric that came out unreadable means the collector broke, not that the pipeline is cheap',
  );
  assert.equal(reading.value, null);
  assert.equal(reading.breached, null);
  assert.equal(reading.sampleCount, 50, 'the samples were there; the arithmetic was not');
  assert.deepEqual(checkShadowSloReading(reading, definition), []);
});

test('the safety block rate is measured over runs that produced a deliverable', async () => {
  const definition = definitionFor('shadow-safety-block-rate');
  const items = await observations(45, (index) =>
    index < 5
      ? { plan: { safetyDisposition: 'block' } }
      : index < 10
        ? { plan: { behaviours: { coaching: { kind: 'errors', failureCode: 'INTERNAL_ERROR' } } } }
        : {},
  );
  const reading = computeShadowSloReading(definition, collected(items), OBSERVED_AT);
  assert.equal(reading.status, 'measured');
  assert.equal(reading.sampleCount, 40, 'the five withheld runs have no disposition to read');
  assert.equal(reading.value, 0.125);
  assert.equal(reading.breached, true);
});

test('the replay divergence rate counts only runs a replay was attempted for', async () => {
  const definition = definitionFor('shadow-replay-divergence-rate');
  const items = await observations(25, (index) => ({
    replayAgreed: index >= 20 ? null : index === 0 ? false : true,
  }));
  const reading = computeShadowSloReading(definition, collected(items), OBSERVED_AT);
  assert.equal(reading.status, 'measured');
  assert.equal(reading.sampleCount, 20, 'five runs nobody replayed are not five runs that agreed');
  assert.equal(reading.value, 0.05);
  assert.equal(reading.breached, true);
});

test('the trace completeness rate is judged by the contract checker, not by a flag', async () => {
  const definition = definitionFor('shadow-trace-completeness-rate');
  const items = await observations(20);
  const clean = computeShadowSloReading(definition, collected(items), OBSERVED_AT);
  assert.equal(clean.status, 'measured');
  assert.equal(clean.value, 1);
  assert.equal(clean.breached, false);

  const brokenTrace: ShadowPipelineTrace = {
    ...items[0].trace,
    stages: items[0].trace.stages.map((stage, index) =>
      index === 3 ? { ...stage, position: 99 } : stage,
    ),
  };
  const damaged = [{ ...items[0], trace: brokenTrace }, ...items.slice(1)];
  const reading = computeShadowSloReading(definition, collected(damaged), OBSERVED_AT);
  assert.equal(reading.status, 'measured');
  assert.equal(reading.value, 0.95);
  assert.equal(reading.breached, true, 'at_least means a fall below the threshold breaches');
});

/* ── The whole catalog at once ───────────────────────────────────── */

test('a batch produces one well-formed reading per catalog entry', async () => {
  const items = await observations(50, () => ({ costMicros: 2400 }));
  const readings = computeShadowSloReadings(collected(items), OBSERVED_AT);
  assert.equal(readings.length, 7);
  for (const { definition, reading } of readings) {
    assert.deepEqual(
      checkShadowSloReading(reading, definition),
      [],
      `${definition.sloId} produced a reading its own definition rejects`,
    );
    assert.equal(reading.sloId, definition.sloId);
  }
  const timeout = readings.find((item) => item.definition.sloId === 'shadow-module-timeout-rate');
  assert.ok(timeout);
  assert.equal(timeout.reading.status, 'measured', 'fifty runs is 400 module executions');
});

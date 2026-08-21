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
  SHADOW_SLO_WINDOW_MILLIS,
  checkShadowPipelineOutcome,
  checkShadowSloReading,
  checkShadowTrace,
  millisBetweenInstants,
  type Instant,
  type ShadowPipelineTrace,
  type ShadowSloReading,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { shadowSloById } from '../../lib/operations/shadowSloCatalog.ts';
import {
  computeShadowSloReading,
  computeShadowSloReadings,
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
  assert.equal(reading.sampleCount, 160, 'twenty runs of an eight-module chain is 160 executions');
  assert.equal(reading.value, 0.025);
  assert.equal(reading.breached, true);
});

test('nineteen runs cannot satisfy a module-run floor of 160 either', async () => {
  const definition = definitionFor('shadow-module-timeout-rate');
  const reading = computeShadowSloReading(definition, collected(await observations(19)), OBSERVED_AT);
  assert.equal(reading.status, 'inconclusive');
  assert.equal(reading.sampleCount, 152);
  assert.equal(reading.inconclusiveReason, 'insufficient_sample');
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

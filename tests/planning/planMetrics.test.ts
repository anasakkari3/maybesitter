/**
 * Plan quality metrics (Sprint 07, issue #31).
 *
 * The `Plan` values here are built by hand. That is deliberate and it is the
 * point of the module's shape: metrics take a plan as *data*, so this file
 * imports no scheduler, and a metric can be pinned to an exact number without
 * anyone first agreeing on how the plan was produced. A metrics suite that had
 * to run a scheduler to get a fixture would be measuring the scheduler.
 *
 * The two cases most likely to be got wrong quietly are asserted first: a
 * placement rate over zero items, and churn with nothing to compare against.
 * Both have a defensible-looking wrong answer — `0` and `null` — and both would
 * be read by a caller as a bad plan rather than as a first run.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computePlanQualityMetrics } from '../../lib/planning/evaluation/metrics.ts';
import {
  PLANNING_CONTRACT_VERSION,
  PLANNING_SCHEMA_VERSION,
  type Plan,
  type PlannedItem,
  type PlanningReasonCode,
  type UnscheduledItem,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON = { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-16T00:00:00.000Z' };

function placed(itemId: string, startsAt: string, minutes: number, buffer = 0): PlannedItem {
  const start = Date.parse(startsAt);
  return {
    itemId,
    interval: {
      startsAt: new Date(start).toISOString(),
      endsAt: new Date(start + minutes * 60_000).toISOString(),
    },
    reservedInterval: {
      startsAt: new Date(start - buffer * 60_000).toISOString(),
      endsAt: new Date(start + (minutes + buffer) * 60_000).toISOString(),
    },
  };
}

function dropped(itemId: string, code: PlanningReasonCode): UnscheduledItem {
  return { itemId, reason: { code, itemId, detail: `item ${itemId}` } };
}

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    version: PLANNING_CONTRACT_VERSION,
    schema: PLANNING_SCHEMA_VERSION,
    scopeId: 'scope-metrics',
    horizon: HORIZON,
    scheduled: [],
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'digest-a',
    ...overrides,
  };
}

/* ── The empty denominators ──────────────────────────────────────── */

test('placementRate over zero items is 1, not 0', () => {
  const metrics = computePlanQualityMetrics({ plan: plan(), availableMinutes: 480 });

  // Zero is a measurement — "nothing got placed" — and an empty denominator is
  // the absence of one. A planner asked to place nothing placed everything it
  // was asked to.
  assert.equal(metrics.placementRate, 1);
  assert.equal(metrics.scheduledCount, 0);
  assert.equal(metrics.unscheduledCount, 0);
  assert.deepEqual(metrics.unscheduledByReason, {});
  assert.equal(metrics.utilization, 0);
});

test('churnMinutes with no previous plan is 0, and is never null', () => {
  const first = plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60)] });

  const omitted = computePlanQualityMetrics({ plan: first, availableMinutes: 480 });
  const explicitlyNull = computePlanQualityMetrics({ plan: first, previousPlan: null, availableMinutes: 480 });

  // A metric that is sometimes absent forces every consumer to branch, and
  // "nothing moved" is the honest reading of a first run.
  assert.equal(omitted.churnMinutes, 0);
  assert.equal(explicitlyNull.churnMinutes, 0);
  assert.equal(typeof omitted.churnMinutes, 'number');
});

test('utilization over zero available minutes is 0 rather than a division by zero', () => {
  const metrics = computePlanQualityMetrics({
    plan: plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60)] }),
    availableMinutes: 0,
  });

  assert.equal(metrics.utilization, 0);
  assert.ok(Number.isFinite(metrics.utilization));
});

/* ── Counts and rates ────────────────────────────────────────────── */

test('scheduled and unscheduled counts, and the rate between them', () => {
  const metrics = computePlanQualityMetrics({
    plan: plan({
      scheduled: [
        placed('i-1', '2026-11-09T09:00:00.000Z', 60),
        placed('i-2', '2026-11-09T11:00:00.000Z', 60),
      ],
      unscheduled: [dropped('i-3', 'NO_FEASIBLE_SLOT')],
    }),
    availableMinutes: 480,
  });

  assert.equal(metrics.scheduledCount, 2);
  assert.equal(metrics.unscheduledCount, 1);
  assert.equal(metrics.placementRate, 2 / 3);
});

test('utilization measures reserved time, because buffers occupy the calendar too', () => {
  const metrics = computePlanQualityMetrics({
    plan: plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60, 15)] }),
    availableMinutes: 360,
  });

  // 15 + 60 + 15 = 90 minutes of the day are spoken for. Measuring only the
  // effort would report 60 and understate how full the week is by exactly the
  // recovery time the user asked for.
  assert.equal(metrics.utilization, 90 / 360);
});

test('utilization above 1 is reported, not clamped', () => {
  const metrics = computePlanQualityMetrics({
    plan: plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 600)] }),
    availableMinutes: 300,
  });

  // A plan that reserved more time than exists is a planner bug. Clamping to 1
  // would render it as a full week.
  assert.equal(metrics.utilization, 2);
});

/* ── unscheduledByReason ─────────────────────────────────────────── */

test('unscheduledByReason counts each code that occurred and omits the ones that did not', () => {
  const metrics = computePlanQualityMetrics({
    plan: plan({
      unscheduled: [
        dropped('i-1', 'NO_FEASIBLE_SLOT'),
        dropped('i-2', 'NO_FEASIBLE_SLOT'),
        dropped('i-3', 'EFFORT_UNKNOWN'),
      ],
    }),
    availableMinutes: 480,
  });

  assert.deepEqual(metrics.unscheduledByReason, { EFFORT_UNKNOWN: 1, NO_FEASIBLE_SLOT: 2 });
  assert.equal(
    Object.prototype.hasOwnProperty.call(metrics.unscheduledByReason, 'HORIZON_EXHAUSTED'),
    false,
    'a code that did not occur must be absent, not present as zero',
  );
});

test('unscheduledByReason serialises in contract order, whatever order the plan listed', () => {
  const forwards = computePlanQualityMetrics({
    plan: plan({
      unscheduled: [dropped('i-1', 'NO_FEASIBLE_SLOT'), dropped('i-2', 'EFFORT_UNKNOWN')],
    }),
    availableMinutes: 480,
  });
  const backwards = computePlanQualityMetrics({
    plan: plan({
      unscheduled: [dropped('i-2', 'EFFORT_UNKNOWN'), dropped('i-1', 'NO_FEASIBLE_SLOT')],
    }),
    availableMinutes: 480,
  });

  // Insertion order is what an object literal serialises by, so a report built
  // from two runs would differ byte-for-byte on nothing but input ordering.
  assert.equal(JSON.stringify(forwards.unscheduledByReason), '{"EFFORT_UNKNOWN":1,"NO_FEASIBLE_SLOT":1}');
  assert.equal(JSON.stringify(backwards.unscheduledByReason), JSON.stringify(forwards.unscheduledByReason));
});

/* ── Churn ───────────────────────────────────────────────────────── */

test('churnMinutes sums absolute shifts, so moving earlier costs as much as moving later', () => {
  const previous = plan({
    scheduled: [
      placed('i-1', '2026-11-09T09:00:00.000Z', 60),
      placed('i-2', '2026-11-09T13:00:00.000Z', 60),
    ],
  });
  const next = plan({
    inputDigest: 'digest-b',
    scheduled: [
      placed('i-1', '2026-11-09T10:30:00.000Z', 60),
      placed('i-2', '2026-11-09T12:00:00.000Z', 60),
    ],
  });

  const metrics = computePlanQualityMetrics({ plan: next, previousPlan: previous, availableMinutes: 480 });

  assert.equal(metrics.churnMinutes, 90 + 60);
});

test('churn is measured on the effort interval, not on a buffer that changed around it', () => {
  const previous = plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60, 0)] });
  const next = plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60, 30)] });

  // What a user experiences as "this moved" is when the work happens. A wider
  // buffer is a different fact and reporting it as churn would make every
  // buffer change look like a rescheduling.
  assert.equal(
    computePlanQualityMetrics({ plan: next, previousPlan: previous, availableMinutes: 480 }).churnMinutes,
    0,
  );
});

test('an item that appeared or vanished is not churn: it did not move', () => {
  const previous = plan({
    scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60)],
    unscheduled: [dropped('i-2', 'NO_FEASIBLE_SLOT')],
  });
  const next = plan({
    scheduled: [placed('i-2', '2026-11-09T09:00:00.000Z', 60)],
    unscheduled: [dropped('i-1', 'NO_FEASIBLE_SLOT')],
  });

  // Counting an appearance as a shift of its own length would make a first run
  // of ten items look like maximal churn, which is the one run where nothing
  // could possibly have moved.
  assert.equal(
    computePlanQualityMetrics({ plan: next, previousPlan: previous, availableMinutes: 480 }).churnMinutes,
    0,
  );
});

test('churn is computed across differing input digests, which is the re-plan case', () => {
  const previous = plan({ scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60)], inputDigest: 'before' });
  const next = plan({ scheduled: [placed('i-1', '2026-11-09T11:00:00.000Z', 60)], inputDigest: 'after' });

  // A re-plan follows a change to the constraints, so the digests differ by
  // construction. Refusing to measure churn there would refuse to measure it in
  // the only situation it exists for.
  assert.equal(
    computePlanQualityMetrics({ plan: next, previousPlan: previous, availableMinutes: 480 }).churnMinutes,
    120,
  );
});

/* ── Refusals ────────────────────────────────────────────────────── */

test('a plan listing one item as both scheduled and unscheduled is refused', () => {
  const contradictory = plan({
    scheduled: [placed('i-1', '2026-11-09T09:00:00.000Z', 60)],
    unscheduled: [dropped('i-1', 'NO_FEASIBLE_SLOT')],
  });

  // The contract says the two lists "together cover every input item exactly
  // once". Scoring this would produce a placement rate of 1/2 for one item and
  // report it as a quality figure rather than as the planner bug it is.
  assert.throws(
    () => computePlanQualityMetrics({ plan: contradictory, availableMinutes: 480 }),
    /both scheduled and unscheduled/,
  );
});

test('a plan listing one item twice is refused', () => {
  const duplicated = plan({
    scheduled: [
      placed('i-1', '2026-11-09T09:00:00.000Z', 60),
      placed('i-1', '2026-11-09T11:00:00.000Z', 60),
    ],
  });

  assert.throws(() => computePlanQualityMetrics({ plan: duplicated, availableMinutes: 480 }), /more than once/);
});

test('a negative availableMinutes is refused rather than turned into a negative utilization', () => {
  assert.throws(
    () => computePlanQualityMetrics({ plan: plan(), availableMinutes: -1 }),
    /availableMinutes/,
  );
});

/* ── Determinism ─────────────────────────────────────────────────── */

test('metrics are a pure function of the plans they are given', () => {
  const previous = plan({ scheduled: [placed('i-b', '2026-11-09T09:00:00.000Z', 60)] });
  const next = plan({
    scheduled: [
      placed('i-b', '2026-11-09T10:00:00.000Z', 60),
      placed('i-a', '2026-11-09T13:00:00.000Z', 30, 10),
    ],
    unscheduled: [dropped('i-c', 'BLOCKED_BY_DEPENDENCY')],
  });

  const once = computePlanQualityMetrics({ plan: next, previousPlan: previous, availableMinutes: 600 });
  const twice = computePlanQualityMetrics({ plan: next, previousPlan: previous, availableMinutes: 600 });

  assert.deepEqual(once, twice);
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
});

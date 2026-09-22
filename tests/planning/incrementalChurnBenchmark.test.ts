/**
 * The churn benchmark (#524): "Benchmark shows lower churn than full
 * regeneration for localized changes."
 *
 * The metric is the one the issue names — `PlanQualityMetrics.churnMinutes`
 * from `computePlanQualityMetrics` (#31), summed `|Δ startsAt|` over items
 * scheduled in both plans. No new metric vocabulary: the benchmark is two
 * calls to the existing evaluator over two results of the same change —
 * the incremental patch and a full canonical regeneration of the same
 * `nextConstraints`.
 *
 * What the benchmark demonstrates:
 *
 *  - **A localized change that frees room** (an item shortens) makes a full
 *    regeneration repack everything after it earlier — churn the user never
 *    asked for — while the incremental patch freezes that half of the day and
 *    churns nothing at all.
 *  - **A localized change that must move something** (a meeting lands on a
 *    block) churns exactly the impacted movement under the patch and no more.
 *
 * The comparison is run through the real pipeline, as in the sibling files:
 * `schedulePlan` for both plans, `computeImpactClosure` + `planIncrementalPatch`
 * for the patch, `assessFeasibility` (#29's oracle) for the capacity figure
 * the metric requires.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler/blocks.ts';
import { computeImpactClosure } from '../../lib/planning/incremental/impactClosure.ts';
import { planIncrementalPatch } from '../../lib/planning/incremental/freezeResolve.ts';
import { computePlanQualityMetrics } from '../../lib/planning/evaluation/metrics.ts';
import { assessFeasibility } from '../../lib/planning/evaluation/oracle.ts';
import type { ScheduleBlockSources } from '../../lib/planning/scheduler/blocks.ts';
import type {
  FixedEvent,
  Plan,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';
const SCOPE = 'scope-churn';

const CONFIG: PlanningConfig = { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false };

/** 08:00–20:00 UTC on the Monday under test. */
function workingWindow() {
  return { windowId: 'w0', weekday: 1 as const, startMinute: 8 * 60, endMinute: 20 * 60, timezone: 'UTC' };
}

function item(itemId: string, minutes: number, overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId,
    title: itemId,
    effort: { kind: 'known', minutes },
    earliestStartAt: null,
    deadlineAt: null,
    priority: 1,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...overrides,
  };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: SCOPE,
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow()],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

function sourcesFor(request: PlanningConstraints): ScheduleBlockSources {
  return {
    items: new Map(request.items.map((entry) => [entry.itemId, { kind: 'commitment' as const, id: entry.itemId }])),
    fixedEvents: new Map(request.fixedEvents.flatMap((event) => event.sourceCommitmentId === null
      ? []
      : [[event.eventId, { kind: 'commitment' as const, id: event.sourceCommitmentId }] as const])),
  };
}

function blockIdOf(itemId: string): string {
  return `block:commitment:${itemId}`;
}

/** `churnMinutes` of a candidate result against the base plan. */
function churnOf(candidate: Plan, base: Plan, next: PlanningConstraints): number {
  return computePlanQualityMetrics({
    plan: candidate,
    previousPlan: base,
    availableMinutes: assessFeasibility(next, CONFIG).availableMinutes,
    items: next.items,
  }).churnMinutes;
}

/**
 * The two answers to the same change: the incremental patch, and the full
 * canonical regeneration of the same constraints.
 */
function patchVersusFull(
  baseRequest: PlanningConstraints,
  next: PlanningConstraints,
  changedBlockIds: readonly string[],
  changedFixedEvents: readonly FixedEvent[] = [],
) {
  const base = schedulePlan(baseRequest, CONFIG);
  const baseBlocks = reconcileScheduleBlocks({
    constraints: baseRequest, plan: base, generation: 1, sources: sourcesFor(baseRequest), previous: null,
  });
  const closure = computeImpactClosure({
    blocks: baseBlocks,
    items: baseRequest.items,
    changedBlockIds,
    changedFixedEvents,
    resourceDependenciesOrder: CONFIG.resourceDependenciesOrder,
  });
  const { patch, plan: patched } = planIncrementalPatch({
    basePlan: base,
    baseBlocks,
    closure,
    nextConstraints: next,
    config: CONFIG,
    baseGeneration: 1,
    resultGeneration: 2,
    causeChangeIds: ['chg-1'],
  });
  const regenerated = schedulePlan(next, CONFIG);
  return {
    base,
    patch,
    patched,
    regenerated,
    patchChurn: churnOf(patched, base, next),
    fullChurn: churnOf(regenerated, base, next),
  };
}

test('a localized change that frees room churns less under a patch than under full regeneration', () => {
  // Four morning items packed from 08:00; the first shortens by an hour. A
  // full regeneration repacks everything after it one hour earlier — three
  // hours of churn over a one-hour edit. The patch freezes the later items
  // where they were.
  const baseRequest = constraints({
    items: [item('a', 120), item('b', 120), item('c', 120), item('d', 60)],
  });
  const next = constraints({
    items: [item('a', 60), item('b', 120), item('c', 120), item('d', 60)],
  });

  const result = patchVersusFull(baseRequest, next, [blockIdOf('a')]);

  // The fixture really does make the regeneration repack: b, c and d each
  // start an hour earlier, 180 minutes of movement over one shortened item.
  assert.equal(result.fullChurn, 180, 'the fixture no longer demonstrates repacking churn');
  // The patch churns nothing: `a` keeps its 08:00 start and merely ends
  // earlier, and churnMinutes counts starts.
  assert.equal(result.patchChurn, 0);
  assert.ok(
    result.patchChurn < result.fullChurn,
    `patch churn ${result.patchChurn} is not below full-regeneration churn ${result.fullChurn}`,
  );
  assert.equal(result.patch.mode, 'incremental');

  // Where the difference comes from: the frozen three kept their starts under
  // the patch and moved under the regeneration.
  const startsIn = (plan: Plan) => new Map(plan.scheduled.map((entry) => [entry.itemId, entry.interval.startsAt] as const));
  const patchedStarts = startsIn(result.patched);
  const baseStarts = startsIn(result.base);
  const fullStarts = startsIn(result.regenerated);
  for (const itemId of ['b', 'c', 'd']) {
    assert.equal(patchedStarts.get(itemId), baseStarts.get(itemId), `${itemId} moved under the patch`);
    assert.notEqual(fullStarts.get(itemId), baseStarts.get(itemId), `${itemId} did not repack under full regeneration`);
  }
});

test('a localized change that must move something churns exactly that movement', () => {
  // A meeting lands on the evening block. The patch re-places that one block;
  // the churn is precisely its displacement, with nothing extra — the point of
  // patching is not only less churn than regeneration, but *no unexplained*
  // churn.
  const baseRequest = constraints({
    items: [
      item('morning-a', 60),
      item('morning-b', 60),
      item('morning-c', 60),
      item('evening', 60, { earliestStartAt: '2026-08-17T18:00:00.000Z' }),
    ],
  });
  const meeting: FixedEvent = {
    eventId: 'meeting-18',
    interval: { startsAt: '2026-08-17T18:00:00.000Z', endsAt: '2026-08-17T19:00:00.000Z' },
    sourceCommitmentId: null,
    blocking: true,
  };
  const next = { ...baseRequest, fixedEvents: [meeting] };

  const result = patchVersusFull(baseRequest, next, [], [meeting]);

  // The evening block moves to 19:00: sixty minutes of explained churn, and
  // the frozen mornings contribute nothing.
  assert.equal(result.patchChurn, 60);
  assert.ok(
    result.patchChurn <= result.fullChurn,
    `the patch churned more than a full regeneration (${result.patchChurn} > ${result.fullChurn})`,
  );
  const morningMoved = ['morning-a', 'morning-b', 'morning-c'].some((itemId) => {
    const before = result.base.scheduled.find((entry) => entry.itemId === itemId);
    const after = result.patched.scheduled.find((entry) => entry.itemId === itemId);
    return before?.interval.startsAt !== after?.interval.startsAt;
  });
  assert.equal(morningMoved, false, 'an untouched morning block contributed churn');
});

test('the benchmark reads the canonical metric, not a local recomputation', () => {
  // churnMinutes is #31's contract figure; this pins that the numbers above
  // are that figure rather than a second churn vocabulary grown beside it.
  const baseRequest = constraints({ items: [item('a', 120), item('b', 120)] });
  const next = constraints({ items: [item('a', 60), item('b', 120)] });
  const result = patchVersusFull(baseRequest, next, [blockIdOf('a')]);

  const metrics = computePlanQualityMetrics({
    plan: result.patched,
    previousPlan: result.base,
    availableMinutes: assessFeasibility(next, CONFIG).availableMinutes,
    items: next.items,
  });
  assert.equal(metrics.churnMinutes, result.patchChurn);
  assert.equal(typeof metrics.churnMinutes, 'number');
});

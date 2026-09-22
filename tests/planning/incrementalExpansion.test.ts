/**
 * Smart neighborhood expansion (#524, slice 3): steps 7–8 of the issue's
 * algorithm — "If no feasible patch exists, expand affected neighborhood.
 * Only then escalate to full replan."
 *
 * `tests/planning/incrementalFreezeResolve.test.ts` owns steps 3–6 and the
 * frozen invariant; this file owns the escalation ladder above them:
 *
 *  - `expanded_incremental` is a real reachable mode, and the widening is one
 *    ring at a time — the smallest neighborhood that solves, not a lurch to
 *    the whole day.
 *  - Blocks outside the *expanded* impact set remain byte-identical.
 *  - Full fallback happens only after deterministic expansion fails, and the
 *    reason names the rung the ladder actually stopped at:
 *    `IMPACTED_SET_INFEASIBLE` when there was never anything to widen into,
 *    `EXPANDED_SET_INFEASIBLE` when widening ran and still came up short.
 *
 * The mutation this file is built to catch: removing the widening loop (or
 * making its candidate sets empty) turns the first two tests into
 * `full_fallback` results and the exhausted-ladder test's reason into
 * `impactedSetInfeasible` — three different reds, each naming the broken rung.
 *
 * Fixtures are built by the real machinery, as in the sibling files: the base
 * plan comes from `schedulePlan`, its blocks from `reconcileScheduleBlocks`,
 * the first partition from `computeImpactClosure`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler/blocks.ts';
import { computeImpactClosure } from '../../lib/planning/incremental/impactClosure.ts';
import {
  FALLBACK_REASONS,
  planIncrementalPatch,
} from '../../lib/planning/incremental/freezeResolve.ts';
import type { ScheduleBlockSources } from '../../lib/planning/scheduler/blocks.ts';
import type { ScheduleBlock } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type {
  Plan,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';
const SCOPE = 'scope-expansion';

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

interface Base {
  readonly request: PlanningConstraints;
  readonly plan: Plan;
  readonly blocks: readonly ScheduleBlock[];
}

function basePlanFor(request: PlanningConstraints, generation = 1): Base {
  const plan = schedulePlan(request, CONFIG);
  const blocks = reconcileScheduleBlocks({
    constraints: request, plan, generation, sources: sourcesFor(request), previous: null,
  });
  return { request, plan, blocks };
}

function blockIdOf(itemId: string): string {
  return `block:commitment:${itemId}`;
}

function placementOf(plan: Plan, itemId: string) {
  return plan.scheduled.find((entry) => entry.itemId === itemId);
}

function replan(
  base: Base,
  next: PlanningConstraints,
  options: { changedBlockIds?: readonly string[] } = {},
) {
  const closure = computeImpactClosure({
    blocks: base.blocks,
    items: base.request.items,
    changedBlockIds: options.changedBlockIds ?? [],
    resourceDependenciesOrder: CONFIG.resourceDependenciesOrder,
  });
  const result = planIncrementalPatch({
    basePlan: base.plan,
    baseBlocks: base.blocks,
    closure,
    nextConstraints: next,
    config: CONFIG,
    baseGeneration: 1,
    resultGeneration: 2,
    causeChangeIds: ['chg-1'],
  });
  return { closure, ...result };
}

/* ── "If no feasible patch exists, expand affected neighborhood" ── */

test('an infeasible first closure widens one ring and solves as expanded_incremental', () => {
  // `c` grows past every free run its frozen neighbours leave: its own slot
  // (60) and the trailing slack (240) are each too small, and `b` sits on the
  // one stretch that could hold it. Unfreezing the abutting ring — `b` before
  // and `d` after — lets the three reshuffle into a feasible packing while
  // `a` stays exactly where it was.
  const base = basePlanFor(constraints({
    items: [item('a', 60), item('b', 300), item('c', 60), item('d', 60)],
  }));
  assert.deepEqual(
    [placementOf(base.plan, 'a')?.interval.startsAt,
      placementOf(base.plan, 'b')?.interval.startsAt,
      placementOf(base.plan, 'c')?.interval.startsAt,
      placementOf(base.plan, 'd')?.interval.startsAt],
    ['2026-08-17T08:00:00.000Z', '2026-08-17T09:00:00.000Z',
      '2026-08-17T14:00:00.000Z', '2026-08-17T15:00:00.000Z'],
    'the fixture does not start packed as the ring arithmetic assumes',
  );

  const next = constraints({ items: [item('a', 60), item('b', 300), item('c', 300), item('d', 60)] });
  const { closure, patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('c')] });

  // The first closure could not solve this: with `b` and `d` frozen, the free
  // runs are 14:00–15:00 (60) and 16:00–20:00 (240), and `c` needs 300.
  assert.deepEqual(closure.impactedBlockIds, [blockIdOf('c')]);

  assert.equal(patch.mode, 'expanded_incremental');
  assert.equal(patch.fallbackReason, null);
  // One ring, not the whole day: the abutting neighbours joined, `a` did not.
  assert.deepEqual(patch.impactedBlockIds, [blockIdOf('b'), blockIdOf('c'), blockIdOf('d')].sort());
  assert.deepEqual(patch.frozenBlockIds, [blockIdOf('a')]);

  // The invariant, on the expanded partition: the block outside the widened
  // impact set is byte-identical in placement.
  assert.deepEqual(placementOf(plan, 'a'), placementOf(base.plan, 'a'), 'a moved, and stayed outside every ring');

  // And the widened solve genuinely happened: `c` occupies 300 minutes across
  // what was `d`'s slot — a placement the first closure's runs could not have
  // held, so this cannot be a lucky first-attempt result.
  const grown = placementOf(plan, 'c');
  assert.ok(grown, 'the grown item was dropped rather than re-placed');
  assert.equal(grown.interval.startsAt, '2026-08-17T14:00:00.000Z');
  assert.equal(grown.interval.endsAt, '2026-08-17T19:00:00.000Z');
  // Every widened item is placed, and `d` visibly moved to make room.
  const displaced = placementOf(plan, 'd');
  assert.ok(displaced, 'd was dropped by the widened solve');
  assert.notEqual(displaced.interval.startsAt, placementOf(base.plan, 'd')!.interval.startsAt);
});

test('expansion is deterministic: the same infeasible input widens the same way', () => {
  const build = () => {
    const base = basePlanFor(constraints({
      items: [item('a', 60), item('b', 300), item('c', 60), item('d', 60)],
    }));
    const next = constraints({ items: [item('a', 60), item('b', 300), item('c', 300), item('d', 60)] });
    return replan(base, next, { changedBlockIds: [blockIdOf('c')] });
  };
  const first = build();
  const second = build();
  assert.equal(first.patch.mode, 'expanded_incremental');
  assert.deepEqual(first.patch, second.patch);
  assert.deepEqual(first.plan, second.plan);
});

test('a feasible first closure never widens', () => {
  // The ladder's first rung is also its most common one: expansion machinery
  // that ran on every patch would churn the neighborhood it exists to protect.
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60), item('c', 60)] }));
  const next = constraints({ items: [item('a', 60), item('b', 90), item('c', 60)] });
  const { closure, patch } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.equal(patch.mode, 'incremental');
  assert.deepEqual(patch.impactedBlockIds, closure.impactedBlockIds);
  assert.deepEqual(patch.frozenBlockIds, closure.frozenBlockIds);
});

/* ── "Only then escalate to full replan" ────────────────────────── */

test('expansion that cannot widen at all falls back as impacted-set-infeasible', () => {
  // One item, a deadline, and a growth no legal start can hold: 600 minutes
  // due by noon. There are no frozen neighbours — the ring is empty on the
  // first failure, so the reason is that widening was impossible, not that it
  // was tried.
  const base = basePlanFor(constraints({
    items: [item('a', 60, { deadlineAt: '2026-08-17T12:00:00.000Z' })],
  }));
  assert.ok(placementOf(base.plan, 'a'), 'the fixture item did not fit to begin with');

  const next = constraints({
    items: [item('a', 600, { deadlineAt: '2026-08-17T12:00:00.000Z' })],
  });
  const { patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('a')] });

  assert.equal(patch.mode, 'full_fallback');
  assert.equal(patch.fallbackReason, FALLBACK_REASONS.impactedSetInfeasible);
  assert.deepEqual(plan, schedulePlan(next, CONFIG));
});

test('expansion that runs and still cannot solve falls back as expanded-set-infeasible', () => {
  // `c` grows past what the frozen neighbours leave, so the ladder widens —
  // `b` abuts `c`, `a` abuts `b` — and the fully widened set still cannot
  // place 18 hours of work in a 12-hour window. The reason records that the
  // widening happened and ran out.
  const base = basePlanFor(constraints({
    items: [item('a', 240), item('b', 240), item('c', 180)],
  }));
  const next = constraints({ items: [item('a', 240), item('b', 240), item('c', 600)] });
  const { patch } = replan(base, next, { changedBlockIds: [blockIdOf('c')] });

  assert.equal(patch.mode, 'full_fallback');
  assert.equal(patch.fallbackReason, FALLBACK_REASONS.expandedSetInfeasible);
  assert.notEqual(
    patch.fallbackReason,
    FALLBACK_REASONS.impactedSetInfeasible,
    'widening ran here; reporting the never-widened reason would lie about the ladder',
  );
});

/* ── The ring arithmetic, exercised directly ────────────────────── */

test('the capacity ring reaches abutting blocks, not merely overlapping ones', () => {
  // The load-bearing boundary: `b` ends at the exact minute `c` begins. An
  // expansion that only recognised strict overlap would report nothing to
  // widen into — and the first test in this file would escalate a patch that
  // one ring could solve.
  const base = basePlanFor(constraints({
    items: [item('a', 60), item('b', 300), item('c', 60), item('d', 60)],
  }));
  const bEnd = placementOf(base.plan, 'b')!.reservedInterval.endsAt;
  const cStart = placementOf(base.plan, 'c')!.reservedInterval.startsAt;
  assert.equal(bEnd, cStart, 'the fixture does not have b abutting c');

  const next = constraints({ items: [item('a', 60), item('b', 300), item('c', 300), item('d', 60)] });
  const { patch } = replan(base, next, { changedBlockIds: [blockIdOf('c')] });
  assert.ok(
    patch.impactedBlockIds.includes(blockIdOf('b')),
    'the abutting neighbour was not pulled into the impact set',
  );
});

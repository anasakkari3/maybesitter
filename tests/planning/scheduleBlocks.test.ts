/**
 * Schedule block reconciliation (Launch S3, issue #521), at the layer where the
 * identity scheme lives.
 *
 * The acceptance criteria exercised here are the ones that do not need a
 * database: identity derivation and stability (regenerate, constraint update,
 * duration update), the contracted mapping invariants (exactly one block per
 * item, no orphans, no duplicates), fixed blocks observed rather than solved,
 * and what a user edit does to a block. The end-to-end half — through the
 * stored plan document and the routes — is `tests/dailyPlan/planBlocks.test.ts`.
 *
 * Every plan below is produced by the real scheduler. A reconciler tested
 * against hand-built `Plan` literals would be a test of the fixtures, the same
 * reading `schedulerDiff.test.ts` gives its own subject.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyEditsToBlocks,
  blockForSource,
  reconcileScheduleBlocks,
  sameBlockInterval,
  ScheduleBlockIntegrityError,
  schedulePlan,
  type ScheduleBlockSources,
} from '../../lib/planning/scheduler/index.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
import { computePlanQualityMetrics } from '../../lib/planning/evaluation/metrics.ts';
import {
  SCHEDULE_BLOCK_SCHEMA_VERSION,
  scheduleBlockId,
  type ScheduleBlock,
} from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type {
  FixedEvent,
  Plan,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON_START = '2026-09-21T00:00:00.000Z';
const HORIZON_END = '2026-09-22T00:00:00.000Z';

function config(overrides: Partial<PlanningConfig> = {}): PlanningConfig {
  return { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false, ...overrides };
}

function workingWindow(windowId: string, overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  return { windowId, weekday: 1, startMinute: 540, endMinute: 1020, timezone: 'UTC', ...overrides };
}

function item(itemId: string, overrides: Partial<PlanningItem> = {}): PlanningItem {
  return {
    itemId,
    title: `title of ${itemId}`,
    effort: { kind: 'known', minutes: 60 },
    earliestStartAt: null,
    deadlineAt: null,
    priority: 0,
    dependsOn: [],
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    ...overrides,
  };
}

function sourcedEvent(eventId: string, sourceId: string, startsAt: string, endsAt: string): FixedEvent {
  return { eventId, interval: { startsAt, endsAt }, sourceCommitmentId: sourceId, blocking: true };
}

function busyEvent(eventId: string, startsAt: string, endsAt: string): FixedEvent {
  return { eventId, interval: { startsAt, endsAt }, sourceCommitmentId: null, blocking: true };
}

function constraints(overrides: Partial<PlanningConstraints> = {}): PlanningConstraints {
  return {
    scopeId: 'scope-blocks',
    timezone: 'UTC',
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    workingWindows: [workingWindow('w-monday')],
    fixedEvents: [],
    items: [],
    ...overrides,
  };
}

/** The source map a real adapter supplies: one entry per item it built. */
function sourcesFor(items: readonly PlanningItem[], fixed: readonly FixedEvent[] = []): ScheduleBlockSources {
  return {
    items: new Map(items.map((entry) => [entry.itemId, { kind: 'commitment' as const, id: entry.itemId }])),
    fixedEvents: new Map(fixed.flatMap((event) => event.sourceCommitmentId === null
      ? []
      : [[event.eventId, { kind: 'commitment' as const, id: event.sourceCommitmentId }] as const])),
  };
}

function reconcile(
  request: PlanningConstraints,
  plan: Plan,
  generation = 1,
  previous?: readonly ScheduleBlock[],
): ScheduleBlock[] {
  return reconcileScheduleBlocks({
    constraints: request,
    plan,
    generation,
    sources: sourcesFor(request.items, request.fixedEvents),
    previous: previous ?? null,
  });
}

function blockOf(blocks: readonly ScheduleBlock[], itemId: string): ScheduleBlock {
  const found = blockForSource(blocks, { kind: 'commitment', id: itemId });
  assert.ok(found, `expected a block for ${itemId}`);
  return found;
}

/* ── Identity derivation ─────────────────────────────────────────── */

test('the schema version is pinned and ids are derived, never minted', () => {
  assert.equal(SCHEDULE_BLOCK_SCHEMA_VERSION, 'schedule-block-v1');
  assert.equal(scheduleBlockId({ kind: 'commitment', id: 'cmt_1' }), 'block:commitment:cmt_1');
  assert.equal(
    scheduleBlockId({ kind: 'habit_occurrence', id: 'habit_9:2026-09-21' }),
    'block:habit_occurrence:habit_9:2026-09-21',
  );
});

test('an identical replay produces identical blocks, id and interval alike', () => {
  const request = constraints({ items: [item('a'), item('b'), item('c')] });
  const first = reconcile(request, schedulePlan(request, config()));
  const second = reconcile(request, schedulePlan(request, config()));
  assert.deepEqual(second, first);
});

test('a duration update retains the block identity', () => {
  const before = constraints({ items: [item('a', { effort: { kind: 'known', minutes: 60 } })] });
  const after = constraints({ items: [item('a', { effort: { kind: 'known', minutes: 45 } })] });

  const beforeBlock = blockOf(reconcile(before, schedulePlan(before, config())), 'a');
  const afterBlock = blockOf(reconcile(after, schedulePlan(after, config())), 'a');

  assert.equal(afterBlock.blockId, beforeBlock.blockId);
  assert.equal(afterBlock.durationMinutes, 45);
  assert.deepEqual(afterBlock.source, beforeBlock.source);
});

test('a constraint update retains the block identity', () => {
  const before = constraints({ items: [item('a')] });
  const after = constraints({ items: [item('a', { deadlineAt: '2026-09-21T12:00:00.000Z' })] });

  const beforeBlock = blockOf(reconcile(before, schedulePlan(before, config())), 'a');
  const afterBlock = blockOf(reconcile(after, schedulePlan(after, config())), 'a');

  assert.equal(afterBlock.blockId, beforeBlock.blockId);
  assert.equal(afterBlock.placement.latestEndAt, '2026-09-21T12:00:00.000Z');
});

test('regeneration over identical inputs keeps ids and intervals, and churn is zero', () => {
  const request = constraints({ items: [item('a'), item('b')] });
  const firstPlan = schedulePlan(request, config());
  const first = reconcile(request, firstPlan, 1);

  const secondPlan = schedulePlan(request, config());
  const second = reconcile(request, secondPlan, 2, first);

  assert.deepEqual(
    second.map((block) => [block.blockId, block.currentInterval]),
    first.map((block) => [block.blockId, block.currentInterval]),
  );
  assert.ok(second.every((block) => block.lastPlanGeneration === 2));

  // Churn is measured in the existing vocabulary: PlanDiff is the canonical
  // diff and `churnMinutes` is #31's metric over it. A no-op replan moves
  // nothing, and both say so.
  const diff = diffPlans(firstPlan, secondPlan);
  assert.equal(diff.sameInputDigest, true);
  assert.ok(diff.changes.every((change) => change.kind === 'unchanged'));
  const metrics = computePlanQualityMetrics({ plan: secondPlan, previousPlan: firstPlan, availableMinutes: 480 });
  assert.equal(metrics.churnMinutes, 0);
});

/* ── The contracted mapping ──────────────────────────────────────── */

test('every planner item maps to exactly one block; no orphans, no duplicates', () => {
  const request = constraints({
    fixedEvents: [
      sourcedEvent('ev-pinned', 'cmt-pinned', '2026-09-21T11:00:00.000Z', '2026-09-21T12:00:00.000Z'),
      busyEvent('ev-busy', '2026-09-21T14:00:00.000Z', '2026-09-21T15:00:00.000Z'),
    ],
    // No working window covers 11:00, so the pinned event squeezes nothing;
    // 'late' is placed and 'overflow' demonstrably loses the day.
    items: [
      item('late', { effort: { kind: 'known', minutes: 60 } }),
      item('overflow', { earliestStartAt: '2026-09-21T23:00:00.000Z', deadlineAt: '2026-09-21T23:30:00.000Z' }),
    ],
    workingWindows: [workingWindow('w-monday', { startMinute: 480, endMinute: 600 })],
  });
  const plan = schedulePlan(request, config());
  assert.ok(plan.unscheduled.some((entry) => entry.itemId === 'overflow'), 'fixture: overflow is unscheduled');

  const blocks = reconcile(request, plan);

  const itemIds = [...plan.scheduled.map((entry) => entry.itemId), ...plan.unscheduled.map((entry) => entry.itemId)];
  for (const itemId of itemIds) {
    assert.equal(
      blocks.filter((block) => block.mobility === 'flexible' && block.source.id === itemId).length,
      1,
      `${itemId} must map to exactly one block`,
    );
  }
  // No orphan: every block names an occurrence this request contains.
  const known = new Set([...request.items.map((entry) => entry.itemId), 'cmt-pinned']);
  assert.ok(blocks.every((block) => known.has(block.source.id)), 'a block exists for no occurrence in the request');
  // No duplicates, and the busy event is an obstacle, not a block.
  assert.equal(new Set(blocks.map((block) => block.blockId)).size, blocks.length);
  assert.equal(blockForSource(blocks, { kind: 'commitment', id: 'ev-busy' }), null);
});

test('a fixed block is observed, not solved: it never enters the movable items', () => {
  const request = constraints({
    fixedEvents: [sourcedEvent('ev-pinned', 'cmt-pinned', '2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')],
    items: [item('a')],
  });
  const plan = schedulePlan(request, config());
  const blocks = reconcile(request, plan);

  const fixed = blockOf(blocks, 'cmt-pinned');
  assert.equal(fixed.mobility, 'fixed');
  assert.deepEqual(fixed.currentInterval, { startsAt: '2026-09-21T09:00:00.000Z', endsAt: '2026-09-21T10:00:00.000Z' });
  assert.equal(fixed.durationMinutes, 60);
  // The pinned occurrence is a FixedEvent in the constraints; the solver's
  // movable set contains only the floating item.
  assert.ok(request.items.every((entry) => entry.itemId !== 'cmt-pinned'));
  assert.ok(plan.scheduled.every((entry) => entry.itemId !== 'cmt-pinned'));
});

test('an item with unknown effort is reported, and its block says 0 rather than inventing a length', () => {
  const request = constraints({ items: [item('a', { effort: { kind: 'unknown' } })] });
  const plan = schedulePlan(request, config());
  assert.equal(plan.unscheduled[0]?.reason.code, 'EFFORT_UNKNOWN');
  const block = blockOf(reconcile(request, plan), 'a');
  assert.equal(block.durationMinutes, 0);
  assert.equal(block.currentInterval, null);
});

/* ── Integrity violations are thrown, not stored ─────────────────── */

test('an item with no schedule source is refused', () => {
  const request = constraints({ items: [item('a')] });
  const plan = schedulePlan(request, config());
  assert.throws(
    () => reconcileScheduleBlocks({
      constraints: request, plan, generation: 1, sources: { items: new Map(), fixedEvents: new Map() },
    }),
    ScheduleBlockIntegrityError,
  );
});

test('two occurrences claiming one source are refused rather than merged', () => {
  const request = constraints({ items: [item('a'), item('b')] });
  const plan = schedulePlan(request, config());
  const duplicated: ScheduleBlockSources = {
    items: new Map([
      ['a', { kind: 'commitment', id: 'same' }],
      ['b', { kind: 'commitment', id: 'same' }],
    ]),
    fixedEvents: new Map(),
  };
  assert.throws(
    () => reconcileScheduleBlocks({ constraints: request, plan, generation: 1, sources: duplicated }),
    /same schedule source/,
  );
});

test('a plan that does not account for every item exactly once is refused', () => {
  const request = constraints({ items: [item('a'), item('b')] });
  const plan = schedulePlan(request, config());

  const dropped: Plan = { ...plan, scheduled: plan.scheduled.filter((entry) => entry.itemId !== 'a') };
  assert.throws(() => reconcile(request, dropped), ScheduleBlockIntegrityError);

  const doubled: Plan = { ...plan, unscheduled: [...plan.unscheduled, { itemId: 'a', reason: { code: 'NO_FEASIBLE_SLOT', itemId: 'a', detail: 'x' } }] };
  assert.throws(() => reconcile(request, doubled), ScheduleBlockIntegrityError);
});

test('a plan naming an item the request does not contain is refused', () => {
  const request = constraints({ items: [item('a')] });
  const plan = schedulePlan(request, config());
  const foreign: Plan = {
    ...plan,
    scheduled: [...plan.scheduled, { itemId: 'ghost', interval: { startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' }, reservedInterval: { startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' } }],
  };
  assert.throws(() => reconcile(request, foreign), ScheduleBlockIntegrityError);
});

/* ── Provenance across regenerations ─────────────────────────────── */

test('a block the new plan does not place keeps the provenance of its last placement', () => {
  const before = constraints({ items: [item('a')] });
  const first = reconcile(before, schedulePlan(before, config()), 1);
  assert.ok(blockOf(first, 'a').currentInterval !== null, 'fixture: placed in generation 1');

  // Generation 2 cannot fit it: the working window shrank to nothing usable.
  const after = constraints({
    items: [item('a')],
    workingWindows: [workingWindow('w-monday', { startMinute: 540, endMinute: 570 })],
  });
  const secondPlan = schedulePlan(after, config());
  assert.ok(secondPlan.unscheduled.some((entry) => entry.itemId === 'a'), 'fixture: unplaced in generation 2');

  const second = reconcile(after, secondPlan, 2, first);
  const block = blockOf(second, 'a');
  assert.equal(block.blockId, blockOf(first, 'a').blockId);
  assert.equal(block.currentInterval, null);
  assert.equal(block.lastPlacedBy, 'planner');
  assert.equal(block.lastPlanGeneration, 1, 'the generation that last placed it survives');
});

test('a block whose occurrence is gone is dropped, never carried forward as an orphan', () => {
  const before = constraints({ items: [item('a'), item('b')] });
  const first = reconcile(before, schedulePlan(before, config()), 1);

  const after = constraints({ items: [item('a')] });
  const second = reconcile(after, schedulePlan(after, config()), 2, first);

  assert.equal(blockForSource(second, { kind: 'commitment', id: 'b' }), null);
  assert.deepEqual(second.map((block) => block.source.id), ['a']);
});

/* ── Edits ───────────────────────────────────────────────────────── */

test('a move puts the new interval on the block, under the user\'s name, with identity intact', () => {
  const request = constraints({ items: [item('a'), item('b')] });
  const plan = schedulePlan(request, config());
  const blocks = reconcile(request, plan);
  const before = blockOf(blocks, 'a');

  const edited = applyEditsToBlocks(blocks, plan.scheduled, {
    moves: [{ itemId: 'a', startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' }],
    removals: [],
  }, 1);

  const moved = blockOf(edited, 'a');
  assert.equal(moved.blockId, before.blockId);
  assert.deepEqual(moved.source, before.source);
  assert.equal(moved.durationMinutes, before.durationMinutes);
  assert.deepEqual(moved.currentInterval, { startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' });
  assert.equal(moved.lastPlacedBy, 'user');
  assert.equal(moved.lastPlanGeneration, 1);
  // The untouched block reasserts the planner's placement.
  assert.equal(blockOf(edited, 'b').lastPlacedBy, 'planner');
  assert.ok(sameBlockInterval(blockOf(edited, 'b').currentInterval, blockOf(blocks, 'b').currentInterval));
});

test('a removal unplaces the block without deleting its identity', () => {
  const request = constraints({ items: [item('a')] });
  const plan = schedulePlan(request, config());
  const blocks = reconcile(request, plan);

  const edited = applyEditsToBlocks(blocks, plan.scheduled, { moves: [], removals: ['a'] }, 1);
  const removed = blockOf(edited, 'a');
  assert.equal(removed.blockId, blockOf(blocks, 'a').blockId);
  assert.equal(removed.currentInterval, null);
  assert.equal(removed.lastPlacedBy, 'user');
});

test('a follow-up edit that drops a move returns the block to the planner\'s placement', () => {
  const request = constraints({ items: [item('a')] });
  const plan = schedulePlan(request, config());
  const blocks = reconcile(request, plan);
  const plannerInterval = blockOf(blocks, 'a').currentInterval;

  const moved = applyEditsToBlocks(blocks, plan.scheduled, {
    moves: [{ itemId: 'a', startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' }],
    removals: [],
  }, 1);
  // The stored edit record is wholesale: a second edit that moves nothing
  // replaces the first, so the block must not go on claiming the old move.
  const reverted = applyEditsToBlocks(moved, plan.scheduled, { moves: [], removals: ['a'] }, 1);
  assert.equal(blockOf(reverted, 'a').currentInterval, null);

  const back = applyEditsToBlocks(reverted, plan.scheduled, { moves: [], removals: [] }, 1);
  assert.ok(sameBlockInterval(blockOf(back, 'a').currentInterval, plannerInterval));
  assert.equal(blockOf(back, 'a').lastPlacedBy, 'planner');
});

test('fixed blocks are untouched by edits of flexible work', () => {
  const request = constraints({
    fixedEvents: [sourcedEvent('ev-pinned', 'cmt-pinned', '2026-09-21T09:00:00.000Z', '2026-09-21T10:00:00.000Z')],
    items: [item('a')],
  });
  const plan = schedulePlan(request, config());
  const blocks = reconcile(request, plan);

  const edited = applyEditsToBlocks(blocks, plan.scheduled, {
    moves: [{ itemId: 'a', startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' }],
    removals: [],
  }, 1);
  assert.deepEqual(blockOf(edited, 'cmt-pinned'), blockOf(blocks, 'cmt-pinned'));
});

/* ── Scope isolation and idempotency ─────────────────────────────── */

test('a block from another scope is never reconciled into this one', () => {
  const mine = constraints({ scopeId: 'uid-a:2026-09-21', items: [item('a')] });
  const theirs = constraints({ scopeId: 'uid-b:2026-09-21', items: [item('a')] });

  // Account B places the same commitment id and then loses it, so its block
  // carries provenance worth stealing: placed by the *user*, in generation 7.
  const foreign = reconcile(theirs, schedulePlan(theirs, config()), 7).map((block) => ({
    ...block,
    currentInterval: null,
    lastPlacedBy: 'user' as const,
  }));
  assert.equal(blockOf(foreign, 'a').blockId, blockOf(reconcile(mine, schedulePlan(mine, config())), 'a').blockId,
    'fixture: the two scopes really do share the blockId — that is why the scope must be checked');

  // Account A's own generation 2 cannot place it. Nothing of B's may appear.
  const narrow = constraints({
    scopeId: 'uid-a:2026-09-21',
    items: [item('a')],
    workingWindows: [workingWindow('w-monday', { startMinute: 540, endMinute: 570 })],
  });
  const plan = schedulePlan(narrow, config());
  assert.ok(plan.unscheduled.some((entry) => entry.itemId === 'a'), 'fixture: unplaced');

  const blocks = reconcile(narrow, plan, 2, foreign);
  const block = blockOf(blocks, 'a');
  assert.equal(block.scopeId, 'uid-a:2026-09-21');
  assert.equal(block.lastPlacedBy, 'planner', 'another account\'s provenance was read into this scope');
  assert.equal(block.lastPlanGeneration, 2, 'another account\'s generation was read into this scope');
  assert.ok(blocks.every((entry) => entry.scopeId === 'uid-a:2026-09-21'));
});

test('a block records the scope it belongs to, so two accounts never share one', () => {
  const a = reconcile(constraints({ scopeId: 'uid-a:2026-09-21', items: [item('shared')] }),
    schedulePlan(constraints({ scopeId: 'uid-a:2026-09-21', items: [item('shared')] }), config()));
  const b = reconcile(constraints({ scopeId: 'uid-b:2026-09-21', items: [item('shared')] }),
    schedulePlan(constraints({ scopeId: 'uid-b:2026-09-21', items: [item('shared')] }), config()));

  assert.equal(blockOf(a, 'shared').blockId, blockOf(b, 'shared').blockId, 'ids are scope-local by contract');
  assert.notEqual(blockOf(a, 'shared').scopeId, blockOf(b, 'shared').scopeId,
    'the globally unique name is the (scopeId, blockId) pair');
});

test('reconciling and editing are both idempotent', () => {
  const request = constraints({ items: [item('a'), item('b')] });
  const plan = schedulePlan(request, config());

  // Reconciling a plan against the blocks it just produced changes nothing.
  const once = reconcile(request, plan, 3);
  assert.deepEqual(reconcile(request, plan, 3, once), once);

  // Applying one edit set twice lands where applying it once did.
  const edits = {
    moves: [{ itemId: 'a', startsAt: '2026-09-21T12:00:00.000Z', endsAt: '2026-09-21T13:00:00.000Z' }],
    removals: ['b'],
  };
  const edited = applyEditsToBlocks(once, plan.scheduled, edits, 3);
  assert.deepEqual(applyEditsToBlocks(edited, plan.scheduled, edits, 3), edited);
});

/**
 * Impact closure (#524, slice 1).
 *
 * The pinned cases are the issue's own acceptance criteria that this slice
 * can answer: a new 18:00 meeting must not touch unrelated morning blocks; a
 * changed duration must pull in only the necessary dependency successors; and
 * the impacted/frozen partition must be exhaustive both ways. Everything is
 * built by hand as data — the closure reads blocks and items, so a suite that
 * had to run the scheduler to build a fixture would be measuring the
 * scheduler, the same reading `planMetrics.test.ts` records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeImpactClosure,
  ImpactClosureError,
  type ImpactClosure,
  type ImpactClosureInput,
} from '../../lib/planning/incremental/index.ts';
import {
  INCREMENTAL_PATCH_MODES,
  INCREMENTAL_REPLAN_POLICY,
} from '../../src/contracts/v1/incrementalReplanContracts.ts';
import {
  scheduleBlockId,
  type ScheduleBlock,
  type ScheduleBlockSource,
} from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type {
  Effort,
  FixedEvent,
  PlanningDependency,
  PlanningItem,
  TimeInterval,
} from '../../src/contracts/v1/planningContracts.ts';

/* ── Fixtures ────────────────────────────────────────────────────── */

const DAY = '2026-11-09';

function interval(startsAt: string, endsAt: string): TimeInterval {
  return { startsAt: `${DAY}T${startsAt}:00.000Z`, endsAt: `${DAY}T${endsAt}:00.000Z` };
}

function commitmentSource(commitmentId: string): ScheduleBlockSource {
  return { kind: 'commitment', id: commitmentId };
}

function flexBlock(
  commitmentId: string,
  placed: TimeInterval | null,
  overrides: Partial<ScheduleBlock> = {},
): ScheduleBlock {
  const source = commitmentSource(commitmentId);
  return {
    blockId: scheduleBlockId(source),
    scopeId: 'scope-1',
    source,
    mobility: 'flexible',
    durationMinutes: 60,
    placement: { earliestStartAt: null, latestEndAt: null, preferredWindows: [] },
    currentInterval: placed,
    lastPlacedBy: 'planner',
    lastPlanGeneration: 1,
    protection: null,
    ...overrides,
  };
}

function fixedBlock(commitmentId: string, at: TimeInterval): ScheduleBlock {
  return flexBlock(commitmentId, at, { mobility: 'fixed', protection: null });
}

function item(
  itemId: string,
  dependsOn: readonly PlanningDependency[] = [],
  effort: Effort = { kind: 'known', minutes: 60 },
): PlanningItem {
  return {
    itemId,
    title: `item ${itemId}`,
    effort,
    earliestStartAt: null,
    deadlineAt: null,
    priority: 1,
    dependsOn,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
  };
}

function busyEvent(eventId: string, at: TimeInterval, blocking = true): FixedEvent {
  return { eventId, interval: at, sourceCommitmentId: null, blocking };
}

function closure(overrides: Partial<ImpactClosureInput> & Pick<ImpactClosureInput, 'blocks' | 'items'>): ImpactClosure {
  return computeImpactClosure({ changedBlockIds: [], ...overrides });
}

/** The partition contract: every block in exactly one list, both sorted. */
function assertPartition(result: ImpactClosure, blocks: readonly ScheduleBlock[]): void {
  const impacted = new Set(result.impactedBlockIds);
  const frozen = new Set(result.frozenBlockIds);
  for (const block of blocks) {
    const count = (impacted.has(block.blockId) ? 1 : 0) + (frozen.has(block.blockId) ? 1 : 0);
    assert.equal(count, 1, `${block.blockId} must be in exactly one of impacted/frozen`);
  }
  assert.equal(impacted.size + frozen.size, blocks.length, 'the partition must cover the blocks exactly once');
  const sorted = (ids: readonly string[]) => ids.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(result.impactedBlockIds, sorted(result.impactedBlockIds));
  assert.deepEqual(result.frozenBlockIds, sorted(result.frozenBlockIds));
}

/* ── The issue's acceptance cases for this slice ─────────────────── */

test('a new meeting at 18:00 does not expand impact to unrelated morning blocks', () => {
  const morning = flexBlock('c-morning', interval('09:00', '10:00'));
  const midday = flexBlock('c-midday', interval('13:00', '14:00'));
  const evening = flexBlock('c-evening', interval('18:30', '19:30'));
  const blocks = [morning, midday, evening];
  const items = [item('c-morning'), item('c-midday'), item('c-evening')];

  const result = closure({
    blocks,
    items,
    changedFixedEvents: [busyEvent('evt-meeting', interval('18:00', '19:00'))],
  });

  assert.deepEqual(result.impactedBlockIds, [evening.blockId]);
  assert.deepEqual(result.frozenBlockIds, [midday.blockId, morning.blockId].sort());
  assertPartition(result, blocks);
});

test('an abutting meeting overlaps nothing: a block ending at 18:00 is untouched', () => {
  // Half-open intervals, the contract's rule 1: [17:00, 18:00) and
  // [18:00, 19:00) share an instant and do not conflict.
  const before = flexBlock('c-before', interval('17:00', '18:00'));
  const during = flexBlock('c-during', interval('18:15', '18:45'));
  const blocks = [before, during];
  const items = [item('c-before'), item('c-during')];

  const result = closure({
    blocks,
    items,
    changedFixedEvents: [busyEvent('evt-meeting', interval('18:00', '19:00'))],
  });

  assert.deepEqual(result.impactedBlockIds, [during.blockId]);
  assert.deepEqual(result.frozenBlockIds, [before.blockId]);
  assertPartition(result, blocks);
});

test('a changed duration pulls in only its necessary dependency successors, not everything', () => {
  // c-b's duration changed. c-c must follow c-b, c-d must follow c-c — both
  // join. c-e is unrelated work and c-f merely informs c-b; neither moves.
  const b = flexBlock('c-b', interval('09:00', '10:00'));
  const c = flexBlock('c-c', interval('10:00', '11:00'));
  const d = flexBlock('c-d', interval('11:00', '12:00'));
  const e = flexBlock('c-e', interval('14:00', '15:00'));
  const f = flexBlock('c-f', interval('16:00', '17:00'));
  const blocks = [b, c, d, e, f];
  const items = [
    item('c-b'),
    item('c-c', [{ dependsOnItemId: 'c-b', kind: 'temporal' }]),
    item('c-d', [{ dependsOnItemId: 'c-c', kind: 'temporal' }]),
    item('c-e'),
    item('c-f', [{ dependsOnItemId: 'c-b', kind: 'informational' }]),
  ];

  const result = closure({ blocks, items, changedBlockIds: [b.blockId] });

  assert.deepEqual(result.impactedBlockIds, [b.blockId, c.blockId, d.blockId].sort());
  assert.deepEqual(result.frozenBlockIds, [e.blockId, f.blockId].sort());
  assertPartition(result, blocks);
});

test('a dependency successor of an overlapped block joins the closure too', () => {
  // Expansion feeds on the whole direct-impact set, however each member got
  // in: the meeting displaces c-b, and c-b's successor must follow.
  const b = flexBlock('c-b', interval('18:30', '19:30'));
  const c = flexBlock('c-c', interval('20:00', '21:00'));
  const blocks = [b, c];
  const items = [item('c-b'), item('c-c', [{ dependsOnItemId: 'c-b', kind: 'temporal' }])];

  const result = closure({
    blocks,
    items,
    changedFixedEvents: [busyEvent('evt-meeting', interval('18:00', '19:00'))],
  });

  assert.deepEqual(result.impactedBlockIds, [b.blockId, c.blockId].sort());
  assertPartition(result, blocks);
});

test('a predecessor is not pulled in when its successor changes', () => {
  // c-b must precede c-c; c-c's duration changed. c-b's own bounds say
  // nothing about c-c, so c-b's placement stays valid where it sits — the
  // follow-up's step-7 expansion is what widens this, on infeasibility.
  const b = flexBlock('c-b', interval('09:00', '10:00'));
  const c = flexBlock('c-c', interval('10:00', '11:00'));
  const blocks = [b, c];
  const items = [item('c-b'), item('c-c', [{ dependsOnItemId: 'c-b', kind: 'temporal' }])];

  const result = closure({ blocks, items, changedBlockIds: [c.blockId] });

  assert.deepEqual(result.impactedBlockIds, [c.blockId]);
  assert.deepEqual(result.frozenBlockIds, [b.blockId]);
  assertPartition(result, blocks);
});

/* ── What is not a hard edge ─────────────────────────────────────── */

test('a resource edge does not expand the closure in a v1 plan', () => {
  const b = flexBlock('c-b', interval('09:00', '10:00'));
  const c = flexBlock('c-c', interval('11:00', '12:00'));
  const blocks = [b, c];
  const items = [item('c-b'), item('c-c', [{ dependsOnItemId: 'c-b', kind: 'resource' }])];

  const result = closure({ blocks, items, changedBlockIds: [b.blockId] });

  assert.deepEqual(result.impactedBlockIds, [b.blockId]);
  assertPartition(result, blocks);
});

test('a resource edge expands the closure when the base plan ordered by it', () => {
  // `resourceDependenciesOrder` was set when the plan was built, so the edge
  // forced an order there — and moving the predecessor can invalidate it.
  const b = flexBlock('c-b', interval('09:00', '10:00'));
  const c = flexBlock('c-c', interval('11:00', '12:00'));
  const blocks = [b, c];
  const items = [item('c-b'), item('c-c', [{ dependsOnItemId: 'c-b', kind: 'resource' }])];

  const result = closure({
    blocks,
    items,
    changedBlockIds: [b.blockId],
    resourceDependenciesOrder: true,
  });

  assert.deepEqual(result.impactedBlockIds, [b.blockId, c.blockId].sort());
  assertPartition(result, blocks);
});

/* ── Edge cases of the direct-impact rule ────────────────────────── */

test('a non-blocking event is nobody\'s obstacle and impacts nothing', () => {
  const a = flexBlock('c-a', interval('18:30', '19:30'));
  const blocks = [a];
  const result = closure({
    blocks,
    items: [item('c-a')],
    changedFixedEvents: [busyEvent('evt-free', interval('18:00', '19:00'), false)],
  });
  assert.deepEqual(result.impactedBlockIds, []);
  assert.deepEqual(result.frozenBlockIds, [a.blockId]);
  assertPartition(result, blocks);
});

test('an unplaced block overlaps nothing and is not displaced by an event', () => {
  const placed = flexBlock('c-placed', interval('18:30', '19:30'));
  const unplaced = flexBlock('c-unplaced', null);
  const blocks = [placed, unplaced];

  const result = closure({
    blocks,
    items: [item('c-placed'), item('c-unplaced')],
    changedFixedEvents: [busyEvent('evt-meeting', interval('18:00', '19:00'))],
  });

  assert.deepEqual(result.impactedBlockIds, [placed.blockId]);
  assert.deepEqual(result.frozenBlockIds, [unplaced.blockId]);
  assertPartition(result, blocks);
});

test('a fixed block the new meeting overlaps is impacted: it is now double-booked', () => {
  // A pinned block cannot move, but its validity changed — a patch must
  // reckon with that rather than freeze a conflict in place.
  const pinned = fixedBlock('c-pinned', interval('18:15', '19:00'));
  const elsewhere = flexBlock('c-elsewhere', interval('09:00', '10:00'));
  const blocks = [pinned, elsewhere];

  const result = closure({
    blocks,
    items: [item('c-elsewhere')],
    changedFixedEvents: [busyEvent('evt-meeting', interval('18:00', '19:00'))],
  });

  assert.deepEqual(result.impactedBlockIds, [pinned.blockId]);
  assert.deepEqual(result.frozenBlockIds, [elsewhere.blockId]);
  assertPartition(result, blocks);
});

/* ── Refusals and determinism ────────────────────────────────────── */

test('a changed id naming no block of this plan is thrown, not absorbed', () => {
  const a = flexBlock('c-a', interval('09:00', '10:00'));
  assert.throws(
    () => closure({ blocks: [a], items: [item('c-a')], changedBlockIds: ['block:commitment:c-ghost'] }),
    (error: unknown) => error instanceof ImpactClosureError && /c-ghost/.test((error as Error).message),
  );
});

test('a duplicated blockId is an integrity failure, not a partition', () => {
  const a = flexBlock('c-a', interval('09:00', '10:00'));
  const aAgain = flexBlock('c-a', interval('11:00', '12:00'));
  assert.throws(
    () => closure({ blocks: [a, aAgain], items: [item('c-a')] }),
    ImpactClosureError,
  );
});

test('the closure is deterministic and independent of input order', () => {
  const b = flexBlock('c-b', interval('18:30', '19:30'));
  const c = flexBlock('c-c', interval('20:00', '21:00'));
  const a = flexBlock('c-a', interval('09:00', '10:00'));
  const items = [item('c-b'), item('c-c', [{ dependsOnItemId: 'c-b', kind: 'temporal' }]), item('c-a')];
  const input: ImpactClosureInput = {
    blocks: [a, b, c],
    items,
    changedBlockIds: [],
    changedFixedEvents: [busyEvent('evt-meeting', interval('18:00', '19:00'))],
  };

  const first = computeImpactClosure(input);
  const second = computeImpactClosure(input);
  assert.deepEqual(first, second);

  const shuffled = computeImpactClosure({
    ...input,
    blocks: [c, a, b],
    items: [items[2], items[1], items[0]],
  });
  assert.deepEqual(first, shuffled);
});

test('a cyclic dependency cannot loop the expansion', () => {
  // Upstream this is CYCLIC_DEPENDENCY; here it must simply terminate.
  const b = flexBlock('c-b', interval('09:00', '10:00'));
  const c = flexBlock('c-c', interval('10:00', '11:00'));
  const items = [
    item('c-b', [{ dependsOnItemId: 'c-c', kind: 'temporal' }]),
    item('c-c', [{ dependsOnItemId: 'c-b', kind: 'temporal' }]),
  ];

  const result = closure({ blocks: [b, c], items, changedBlockIds: [b.blockId] });

  assert.deepEqual(result.impactedBlockIds, [b.blockId, c.blockId].sort());
  assertPartition(result, [b, c]);
});

/* ── The patch contract vocabulary ───────────────────────────────── */

test('the patch modes are the issue\'s three, and nothing else', () => {
  assert.deepEqual(INCREMENTAL_PATCH_MODES, [
    'incremental',
    'expanded_incremental',
    'full_fallback',
  ]);
  assert.equal(INCREMENTAL_REPLAN_POLICY.newDiffContractCreated, false);
  assert.equal(INCREMENTAL_REPLAN_POLICY.frozenBlocksByteIdentical, true);
});

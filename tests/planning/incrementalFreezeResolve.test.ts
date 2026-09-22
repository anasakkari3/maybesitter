/**
 * Freeze, re-solve, validate, diff (#524, slice 2): steps 3–6, end to end.
 *
 * Every fixture here is built by the real machinery — `schedulePlan` produces
 * the base plan, `reconcileScheduleBlocks` projects its blocks,
 * `computeImpactClosure` partitions them — so what is under test is the
 * pipeline joining them rather than a hand-rolled approximation of their
 * output. A block literal written by hand in this file would be a second
 * opinion about what the projection produces, and the first thing to disagree
 * with it.
 *
 * The tests are the issue's own acceptance criteria, in its words:
 *
 *  - "New meeting at 18:00 does not move unrelated morning blocks."
 *  - "Changed duration of one item moves only its necessary impact closure."
 *  - "Frozen blocks remain identical."
 *  - "Result passes all normal hard-constraint validation."
 *  - "PlanDiff accurately represents resulting movement."
 *  - "Incremental infeasibility escalates deterministically."
 *
 * ── The frozen assertion is the load-bearing one ───────────────────
 *
 * `frozenPlacementDrift` is checked against the *assembled* plan, and the
 * assembly deliberately prefers the solver's answer over the base plan's. That
 * is what makes the assertion catch something: if a frozen item leaked back
 * into the solve and the solver moved it, the merge takes the solver's
 * placement and the drift check fires. The mutation proof for this slice
 * injects exactly that leak.
 *
 * `tests/planning/incrementalImpactClosure.test.ts` owns the partition itself,
 * and `tests/planning/schedulerDiff.test.ts` owns `diffPlans`. Neither is
 * re-proved here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { reconcileScheduleBlocks } from '../../lib/planning/scheduler/blocks.ts';
import { computeImpactClosure } from '../../lib/planning/incremental/impactClosure.ts';
import {
  FALLBACK_REASONS,
  IncrementalReplanError,
  freezeBlocksAsFixedEvents,
  frozenPlacementDrift,
  planIncrementalPatch,
} from '../../lib/planning/incremental/freezeResolve.ts';
import type { ScheduleBlockSources } from '../../lib/planning/scheduler/blocks.ts';
import type { ScheduleBlock } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type {
  FixedEvent,
  Plan,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  TimeInterval,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';
const SCOPE = 'scope-incremental';

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

function busyEvent(eventId: string, startsAt: string, endsAt: string): FixedEvent {
  return { eventId, interval: { startsAt, endsAt }, sourceCommitmentId: null, blocking: true };
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

/** A base plan and its real blocks, through the real projection. */
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

/**
 * The whole pipeline: partition, then freeze/re-solve/validate/diff.
 *
 * The closure's own inputs are the real ones — the base blocks and the base
 * items — so a test that changes an item's duration exercises the same path
 * production would.
 */
function replan(
  base: Base,
  next: PlanningConstraints,
  options: { changedBlockIds?: readonly string[]; changedFixedEvents?: readonly FixedEvent[] } = {},
) {
  const closure = computeImpactClosure({
    blocks: base.blocks,
    items: base.request.items,
    changedBlockIds: options.changedBlockIds ?? [],
    changedFixedEvents: options.changedFixedEvents ?? [],
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

/* ── "New meeting at 18:00 does not move unrelated morning blocks" ── */

test('a new 18:00 meeting leaves every morning block byte-identical', () => {
  // Four hours of morning work, and one item the evening meeting lands on.
  const base = basePlanFor(constraints({
    items: [item('morning-a', 60), item('morning-b', 60), item('morning-c', 60), item('evening', 60)],
    fixedEvents: [],
  }));
  // The solver fills the window from 08:00, so `evening` sits at 11:00. Pin it
  // late instead, so a meeting at 18:00 genuinely collides with something.
  const pinned = constraints({
    items: [
      item('morning-a', 60), item('morning-b', 60), item('morning-c', 60),
      item('evening', 60, { earliestStartAt: '2026-08-17T18:00:00.000Z' }),
    ],
  });
  const pinnedBase = basePlanFor(pinned);
  assert.equal(placementOf(pinnedBase.plan, 'evening')?.interval.startsAt, '2026-08-17T18:00:00.000Z');

  const meeting = busyEvent('meeting-18', '2026-08-17T18:00:00.000Z', '2026-08-17T19:00:00.000Z');
  const next = { ...pinned, fixedEvents: [meeting] };
  const { closure, patch, plan } = replan(pinnedBase, next, { changedFixedEvents: [meeting] });

  // Only the block the meeting sits on is impacted; the mornings are frozen.
  assert.deepEqual(closure.impactedBlockIds, [blockIdOf('evening')]);
  assert.deepEqual(
    closure.frozenBlockIds,
    [blockIdOf('morning-a'), blockIdOf('morning-b'), blockIdOf('morning-c')].sort(),
  );

  assert.equal(patch.mode, 'incremental');
  assert.equal(patch.fallbackReason, null);
  for (const itemId of ['morning-a', 'morning-b', 'morning-c']) {
    assert.deepEqual(
      placementOf(plan, itemId),
      placementOf(pinnedBase.plan, itemId),
      `${itemId} moved, and nothing asked it to`,
    );
  }
  // And the evening item did move — otherwise the test proves only that
  // nothing happened at all.
  assert.notDeepEqual(placementOf(plan, 'evening'), placementOf(pinnedBase.plan, 'evening'));
});

test('the frozen half is entered as blocking events, not left to the solver', () => {
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60)] }));
  const placements = new Map(base.plan.scheduled.map((entry) => [entry.itemId, entry] as const));
  const events = freezeBlocksAsFixedEvents(
    [blockIdOf('a')],
    new Map(base.blocks.map((block) => [block.blockId, block] as const)),
    placements,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, `frozen:${blockIdOf('a')}`);
  assert.equal(events[0].blocking, true);
  // The *reserved* span, so a frozen item's buffers stay its own.
  assert.deepEqual(events[0].interval, {
    startsAt: placements.get('a')?.reservedInterval.startsAt,
    endsAt: placements.get('a')?.reservedInterval.endsAt,
  });
  // Temporary: nothing about it claims a commitment to persist against.
  assert.equal(events[0].sourceCommitmentId, null);
});

test("a frozen item's buffers are frozen with it, not reclaimed", () => {
  const base = basePlanFor(constraints({
    items: [
      item('buffered', 60, { bufferBeforeMinutes: 30, bufferAfterMinutes: 30 }),
      item('other', 60),
    ],
  }));
  const placements = new Map(base.plan.scheduled.map((entry) => [entry.itemId, entry] as const));
  const [event] = freezeBlocksAsFixedEvents(
    [blockIdOf('buffered')],
    new Map(base.blocks.map((block) => [block.blockId, block] as const)),
    placements,
  );
  const reserved = placements.get('buffered')!.reservedInterval;
  const effort = placements.get('buffered')!.interval;
  // The reserved span is genuinely wider here, so this fixture can tell the
  // two readings apart.
  assert.notEqual(reserved.startsAt, effort.startsAt);
  assert.equal(event.interval.startsAt, reserved.startsAt);
});

test('a fixed block is not frozen again, because it already is a fixed event', () => {
  // A sourced blocking event becomes a `fixed` block — `blocks.ts` mints one
  // per event and never asks the solver to place it. It is unaffected here, so
  // it is frozen; freezing it a second time would enter its interval twice and
  // the request would validate as `FIXED_EVENT_CONFLICT`, reporting the user in
  // two places at once at a position nobody moved.
  const appointment: FixedEvent = {
    eventId: 'appt',
    interval: { startsAt: '2026-08-17T12:00:00.000Z', endsAt: '2026-08-17T13:00:00.000Z' },
    sourceCommitmentId: 'appt-source',
    blocking: true,
  };
  const request = constraints({ items: [item('a', 60), item('b', 60)], fixedEvents: [appointment] });
  const base = basePlanFor(request);
  // The fixture really does hold a fixed block, or this proves nothing.
  const fixedBlock = base.blocks.find((block) => block.mobility === 'fixed');
  assert.ok(fixedBlock, 'the fixture produced no fixed block');

  const next = constraints({ items: [item('a', 60), item('b', 120)], fixedEvents: [appointment] });
  const { closure, patch, validation } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.ok(closure.frozenBlockIds.includes(fixedBlock.blockId), 'the fixed block was not frozen');
  assert.deepEqual(
    validation.filter((reason) => reason.code === 'FIXED_EVENT_CONFLICT'),
    [],
    'the fixed block was entered as a fixed event twice',
  );
  assert.equal(patch.mode, 'incremental');
  assert.equal(patch.fallbackReason, null);

  // And the freeze produced no event for it: its position is already in the
  // request, and a second copy is what the conflict above would have been.
  const events = freezeBlocksAsFixedEvents(
    closure.frozenBlockIds,
    new Map(base.blocks.map((block) => [block.blockId, block] as const)),
    new Map(base.plan.scheduled.map((entry) => [entry.itemId, entry] as const)),
  );
  assert.equal(
    events.some((event) => event.eventId === `frozen:${fixedBlock.blockId}`),
    false,
    'a fixed block was frozen a second time',
  );
});

/* ── "Changed duration moves only its necessary impact closure" ───── */

test("a changed duration re-solves its own block and freezes the rest", () => {
  const base = basePlanFor(constraints({
    items: [item('a', 60), item('b', 60), item('c', 60)],
  }));
  // `b` grows from an hour to two.
  const next = constraints({ items: [item('a', 60), item('b', 120), item('c', 60)] });
  const { closure, patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.deepEqual(closure.impactedBlockIds, [blockIdOf('b')]);
  assert.equal(patch.mode, 'incremental');
  for (const itemId of ['a', 'c']) {
    assert.deepEqual(placementOf(plan, itemId), placementOf(base.plan, itemId), `${itemId} moved`);
  }
  // `b` is two hours now, and had to find room that does not overlap either
  // frozen neighbour.
  const placed = placementOf(plan, 'b');
  assert.ok(placed, 'the grown item was dropped rather than re-placed');
  const grown: TimeInterval = placed.interval;
  assert.equal((Date.parse(grown.endsAt) - Date.parse(grown.startsAt)) / 60_000, 120);
  for (const frozen of ['a', 'c']) {
    const other = placementOf(plan, frozen)!;
    const overlaps: boolean = Date.parse(grown.startsAt) < Date.parse(other.interval.endsAt)
      && Date.parse(other.interval.startsAt) < Date.parse(grown.endsAt);
    assert.equal(overlaps, false, `the re-solved item was placed on top of frozen ${frozen}`);
  }
});

test('a dependency successor is re-solved with its predecessor, and only it', () => {
  const base = basePlanFor(constraints({
    items: [
      item('root', 60),
      item('after-root', 60, { dependsOn: [{ dependsOnItemId: 'root', kind: 'temporal' }] }),
      item('unrelated', 60),
    ],
  }));
  const next = constraints({
    items: [
      item('root', 120),
      item('after-root', 60, { dependsOn: [{ dependsOnItemId: 'root', kind: 'temporal' }] }),
      item('unrelated', 60),
    ],
  });
  const { closure, patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('root')] });

  assert.deepEqual(closure.impactedBlockIds, [blockIdOf('after-root'), blockIdOf('root')].sort());
  assert.deepEqual(closure.frozenBlockIds, [blockIdOf('unrelated')]);
  assert.equal(patch.mode, 'incremental');
  assert.deepEqual(placementOf(plan, 'unrelated'), placementOf(base.plan, 'unrelated'));
});

/* ── "Frozen blocks remain identical" ─────────────────────────────── */

test('the drift check sees a frozen block that moved', () => {
  // The assertion's own teeth, exercised directly rather than through a
  // pipeline that is supposed to make it unreachable.
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60)] }));
  const moved: Plan = {
    ...base.plan,
    scheduled: base.plan.scheduled.map((entry) => (entry.itemId !== 'a' ? entry : {
      ...entry,
      interval: { startsAt: '2026-08-17T15:00:00.000Z', endsAt: '2026-08-17T16:00:00.000Z' },
    })),
  };
  assert.deepEqual(frozenPlacementDrift(base.plan, moved, new Set(['a'])), ['a']);
  assert.deepEqual(frozenPlacementDrift(base.plan, base.plan, new Set(['a', 'b'])), []);
  // A placement that vanished is a move of the starkest kind.
  const dropped: Plan = { ...base.plan, scheduled: base.plan.scheduled.filter((e) => e.itemId !== 'a') };
  assert.deepEqual(frozenPlacementDrift(base.plan, dropped, new Set(['a'])), ['a']);
});

test('the same instant written two ways is not a move', () => {
  const base = basePlanFor(constraints({ items: [item('a', 60)] }));
  const reserialised: Plan = {
    ...base.plan,
    scheduled: base.plan.scheduled.map((entry) => ({
      ...entry,
      interval: {
        startsAt: entry.interval.startsAt.replace('.000Z', 'Z'),
        endsAt: entry.interval.endsAt.replace('.000Z', 'Z'),
      },
    })),
  };
  assert.deepEqual(frozenPlacementDrift(base.plan, reserialised, new Set(['a'])), []);
});

/* ── "Result passes all normal hard-constraint validation" ────────── */

test('the patched plan covers every item and reports no static findings', () => {
  const base = basePlanFor(constraints({
    items: [item('a', 60), item('b', 60), item('c', 60)],
  }));
  const next = constraints({ items: [item('a', 60), item('b', 90), item('c', 60)] });
  const { patch, plan, validation } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.equal(patch.mode, 'incremental');
  assert.deepEqual(validation, []);
  // `Plan`'s own promise: scheduled ∪ unscheduled covers every item exactly
  // once. An incremental result that dropped the frozen half would satisfy
  // every per-item assertion above while describing most of a day as missing.
  const covered = [...plan.scheduled.map((e) => e.itemId), ...plan.unscheduled.map((e) => e.itemId)];
  assert.deepEqual(covered.sort(), ['a', 'b', 'c']);
  assert.equal(new Set(covered).size, covered.length, 'an item appears twice in the patched plan');
  // The digest is of the whole request, so this plan is comparable with a full
  // regeneration of the same inputs.
  assert.equal(plan.inputDigest, schedulePlan(next, CONFIG).inputDigest);
});

test('no scheduled item overlaps any other in the patched plan', () => {
  const base = basePlanFor(constraints({
    items: [item('a', 60), item('b', 60), item('c', 60), item('d', 60)],
  }));
  const next = constraints({ items: [item('a', 60), item('b', 120), item('c', 60), item('d', 60)] });
  const { plan } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  const ordered = [...plan.scheduled].sort(
    (l, r) => Date.parse(l.reservedInterval.startsAt) - Date.parse(r.reservedInterval.startsAt),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(
      Date.parse(ordered[index].reservedInterval.startsAt) >= Date.parse(ordered[index - 1].reservedInterval.endsAt),
      `${ordered[index - 1].itemId} and ${ordered[index].itemId} overlap in the patched plan`,
    );
  }
});

/* ── "PlanDiff accurately represents resulting movement" ──────────── */

test('the diff names exactly what moved and leaves the frozen half unchanged', () => {
  const base = basePlanFor(constraints({
    items: [item('a', 60), item('b', 60), item('c', 60)],
  }));
  const next = constraints({ items: [item('a', 60), item('b', 120), item('c', 60)] });
  const { patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  const byId = new Map(patch.diff.changes.map((change) => [change.itemId, change] as const));
  assert.equal(byId.get('a')?.kind, 'unchanged');
  assert.equal(byId.get('c')?.kind, 'unchanged');
  assert.equal(byId.get('b')?.kind, 'moved');
  // The diff is the canonical one over the two plans, not a second computation:
  // it must equal what `diffPlans` says about the same pair.
  assert.deepEqual(patch.diff.changes.map((c) => c.kind).sort(), ['moved', 'unchanged', 'unchanged']);
  // Different requests, honestly reported — the point of the flag.
  assert.equal(patch.diff.sameInputDigest, false);
  assert.ok(plan);
});

test('a patch that changes nothing produces a diff of nothing but unchanged', () => {
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60)] }));
  // Nothing changed and nothing is impacted: everything freezes.
  const { closure, patch } = replan(base, base.request, {});
  assert.deepEqual(closure.impactedBlockIds, []);
  assert.equal(patch.mode, 'incremental');
  assert.ok(patch.diff.changes.every((change) => change.kind === 'unchanged'));
  assert.equal(patch.diff.sameInputDigest, true);
});

/* ── The patch's own provenance ───────────────────────────────────── */

test('the patch records the generations, the causes and the partition it used', () => {
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60)] }));
  const next = constraints({ items: [item('a', 60), item('b', 90)] });
  const { patch } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.equal(patch.schemaVersion, 'incremental-plan-patch-v1');
  assert.equal(patch.scopeId, SCOPE);
  assert.equal(patch.baseGeneration, 1);
  assert.equal(patch.resultGeneration, 2);
  assert.deepEqual(patch.causeChangeIds, ['chg-1']);
  assert.deepEqual(patch.impactedBlockIds, [blockIdOf('b')]);
  assert.deepEqual(patch.frozenBlockIds, [blockIdOf('a')]);
});

/* ── "Incremental infeasibility escalates deterministically" ───────── */

test('an impacted set with nowhere to go widens first, then falls back exhausted', () => {
  // A full window of work, then one item grows far beyond what the day can
  // hold at all. Step 7 widens: `b` abuts `c`'s placement, then `a` abuts
  // `b`'s — and even the fully widened set cannot place 18 hours of work in a
  // 12-hour window. Only then does the ladder escalate.
  const base = basePlanFor(constraints({
    items: [item('a', 240), item('b', 240), item('c', 180)],
  }));
  assert.equal(base.plan.unscheduled.length, 0, 'the fixture did not fit to begin with');

  const next = constraints({ items: [item('a', 240), item('b', 240), item('c', 600)] });
  const { patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('c')] });

  assert.equal(patch.mode, 'full_fallback');
  assert.equal(patch.fallbackReason, FALLBACK_REASONS.expandedSetInfeasible);
  // The contract's reading of a fallback: nothing was frozen, so the solver was
  // asked about everything.
  assert.deepEqual(patch.frozenBlockIds, []);
  assert.deepEqual(patch.impactedBlockIds, base.blocks.map((b) => b.blockId).sort());
  // And it returned a real regenerated plan rather than garbage or a throw.
  assert.ok(plan.scheduled.length + plan.unscheduled.length > 0);
  assert.deepEqual(plan, schedulePlan(next, CONFIG));
});

test('a fallback is deterministic: the same infeasible input escalates the same way', () => {
  const build = () => {
    const base = basePlanFor(constraints({ items: [item('a', 240), item('b', 240), item('c', 180)] }));
    const next = constraints({ items: [item('a', 240), item('b', 240), item('c', 600)] });
    return replan(base, next, { changedBlockIds: [blockIdOf('c')] });
  };
  const first = build();
  const second = build();
  assert.equal(first.patch.mode, second.patch.mode);
  assert.equal(first.patch.fallbackReason, second.patch.fallbackReason);
  assert.deepEqual(first.patch.diff, second.patch.diff);
  assert.deepEqual(first.plan, second.plan);
});

test('a frozen block a new event lands on is unfrozen and re-placed, not fallen back', () => {
  // The closure was computed without being told about the meeting, so a morning
  // block stays frozen under it. Freezing it enters a blocking event that
  // overlaps the meeting — but step 7's conflict set names exactly that block,
  // unfreezes it, and the widened solve places it legally. No full-day
  // regeneration over a conflict one block wide.
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60)] }));
  const placed = placementOf(base.plan, 'a')!;
  const meeting = busyEvent('clash', placed.interval.startsAt, placed.interval.endsAt);
  const next = { ...base.request, fixedEvents: [meeting] };

  // Deliberately *not* passing `changedFixedEvents`, so the closure never sees
  // the collision and leaves `a` frozen.
  const { patch, plan, validation } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.equal(patch.mode, 'expanded_incremental');
  assert.equal(patch.fallbackReason, null);
  assert.deepEqual(patch.impactedBlockIds, [blockIdOf('a'), blockIdOf('b')].sort());
  assert.deepEqual(validation, []);
  // Both items are placed, and neither sits on the meeting.
  for (const itemId of ['a', 'b']) {
    const now = placementOf(plan, itemId);
    assert.ok(now, `${itemId} was dropped rather than re-placed`);
    const overlaps = Date.parse(now.interval.startsAt) < Date.parse(meeting.interval.endsAt)
      && Date.parse(meeting.interval.startsAt) < Date.parse(now.interval.endsAt);
    assert.equal(overlaps, false, `${itemId} was re-placed on top of the meeting`);
  }
});

test('a request invalid on its own terms falls back, with a reason', () => {
  // Two of the request's *own* meetings overlap each other. No frozen block is
  // implicated — the conflict set is empty — so there is nothing step 7 can
  // unfreeze, and the ladder escalates directly.
  const base = basePlanFor(constraints({ items: [item('a', 60), item('b', 60)] }));
  const first = busyEvent('meeting-1', '2026-08-17T18:00:00.000Z', '2026-08-17T19:00:00.000Z');
  const second = busyEvent('meeting-2', '2026-08-17T18:30:00.000Z', '2026-08-17T19:30:00.000Z');
  const next = { ...base.request, fixedEvents: [first, second] };

  const { patch, validation } = replan(base, next, { changedBlockIds: [blockIdOf('b')] });

  assert.equal(patch.mode, 'full_fallback');
  assert.equal(patch.fallbackReason, FALLBACK_REASONS.frozenConstraintsInvalid);
  assert.ok(
    validation.some((reason) => reason.code === 'FIXED_EVENT_CONFLICT'),
    `expected a FIXED_EVENT_CONFLICT, got ${JSON.stringify(validation.map((r) => r.code))}`,
  );
});

test('an item that was already unplaced and still is does not trigger a fallback', () => {
  // Regression, not absence, is what escalates. An item nobody could place
  // before and nobody can place now has taken nothing away from the user, and
  // regenerating the whole day over it would churn everything to change
  // nothing.
  const base = basePlanFor(constraints({
    items: [item('fits', 60), item('never', 1200)],
  }));
  assert.deepEqual(base.plan.unscheduled.map((entry) => entry.itemId), ['never']);

  const next = constraints({ items: [item('fits', 60), item('never', 1300)] });
  const { patch } = replan(base, next, { changedBlockIds: [blockIdOf('never')] });
  assert.equal(patch.mode, 'incremental');
  assert.equal(patch.fallbackReason, null);
});

/* ── Refusals ─────────────────────────────────────────────────────── */

test('a closure naming a block this plan does not have is refused', () => {
  const base = basePlanFor(constraints({ items: [item('a', 60)] }));
  assert.throws(
    () => planIncrementalPatch({
      basePlan: base.plan,
      baseBlocks: base.blocks,
      closure: { impactedBlockIds: ['block:commitment:ghost'], frozenBlockIds: [] },
      nextConstraints: base.request,
      config: CONFIG,
      baseGeneration: 1,
      resultGeneration: 2,
      causeChangeIds: [],
    }),
    IncrementalReplanError,
  );
});

test('a frozen block this plan does not have is refused rather than skipped', () => {
  const base = basePlanFor(constraints({ items: [item('a', 60)] }));
  assert.throws(
    () => planIncrementalPatch({
      basePlan: base.plan,
      baseBlocks: base.blocks,
      closure: { impactedBlockIds: [], frozenBlockIds: ['block:commitment:ghost'] },
      nextConstraints: base.request,
      config: CONFIG,
      baseGeneration: 1,
      resultGeneration: 2,
      causeChangeIds: [],
    }),
    IncrementalReplanError,
  );
});

test('a frozen block the base plan never placed holds no position, and blocks nothing', () => {
  const base = basePlanFor(constraints({
    items: [item('fits', 60), item('never', 1200)],
  }));
  // `never` is frozen and unplaced: it contributes no fixed event, and it stays
  // unplaced in the patched plan rather than being pinned somewhere invented.
  const next = constraints({ items: [item('fits', 120), item('never', 1200)] });
  const { patch, plan } = replan(base, next, { changedBlockIds: [blockIdOf('fits')] });
  assert.equal(patch.mode, 'incremental');
  assert.deepEqual(plan.unscheduled.map((entry) => entry.itemId), ['never']);
});

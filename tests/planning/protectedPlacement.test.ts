/**
 * Protected-flexible placement (Launch S3, issue #522), at the solver.
 *
 * The one sentence this file exists to keep true is the issue's: **protection
 * is not priority**. Everything below is arranged so that a change which
 * quietly collapses the two — "treat Must as protected", "sort protected first
 * by giving it a priority bump" — fails here rather than shipping as a planner
 * that never moves anything important again.
 *
 * Four of these tests are written against the *output* rather than against the
 * policy that produced it, because the policy is exactly what a defect would
 * change:
 *
 *  - `withinMaxShift` is asked about every placement the scheduler made, so
 *    "the bound is never silently exceeded" is a property of the plan and not
 *    of the line that computes the bound;
 *  - the churn comparison runs the *same request* twice, once with the
 *    protection and once without, and compares the two plans on the shared
 *    metric — which is the only form of "chooses the plan with lower protected
 *    churn" a greedy placer can be held to, and a stronger one than asserting
 *    an interval;
 *  - the buffer tests re-derive `reservedInterval` from the item's own buffers,
 *    so a protection that started widening reservations would be visible;
 *  - determinism is asserted on a full structural comparison of two runs, not
 *    on a digest, because a digest agreeing with itself proves nothing about
 *    the plan.
 *
 * Block-level protection, persistence and the Plan boundary's mutation live in
 * `tests/dailyPlan/planProtection.test.ts`. The identity scheme those blocks
 * carry is #521's and is pinned in `tests/planning/scheduleBlocks.test.ts`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { schedulePlan } from '../../lib/planning/scheduler/index.ts';
import { planningInputDigest } from '../../lib/planning/scheduler/digest.ts';
import {
  compareProtectionRetention,
  isProtected,
  projectBlockProtectionIntoPlanningConstraints,
  protectedStartBoundsMs,
  protectionAfterMove,
  retainedStartMs,
  withinMaxShift,
} from '../../lib/planning/scheduler/protection.ts';
import { computePlanQualityMetrics } from '../../lib/planning/evaluation/metrics.ts';
import { ownershipOf, type ScheduleBlock } from '../../src/contracts/v1/scheduleBlockContracts.ts';
import type {
  FixedEvent,
  PlacementProtection,
  Plan,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  TimeInterval,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';

/* ── Fixtures ────────────────────────────────────────────────────── */

const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';
const SCOPE = 'scope-protected';

/** Priorities as the daily-plan adapter mints them: high 3, normal 2, low 1. */
const MUST = 3;
const NICE = 1;

function config(overrides: Partial<PlanningConfig> = {}): PlanningConfig {
  return { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false, ...overrides };
}

function workingWindow(overrides: Partial<WorkingWindow> = {}): WorkingWindow {
  // Monday 09:00–17:00 UTC. 2026-08-17 is a Monday.
  return { windowId: 'w', weekday: 1, startMinute: 540, endMinute: 1020, timezone: 'UTC', ...overrides };
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

function at(hour: number, minute = 0): string {
  return `2026-08-17T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function interval(fromHour: number, toHour: number): TimeInterval {
  return { startsAt: at(fromHour), endsAt: at(toHour) };
}

function protection(overrides: Partial<PlacementProtection> = {}): PlacementProtection {
  return {
    ownership: 'protected_flexible',
    origin: 'user',
    preferredInterval: interval(9, 10),
    maxShiftMinutes: null,
    ...overrides,
  };
}

function fixedEvent(eventId: string, startsAt: string, endsAt: string): FixedEvent {
  return { eventId, interval: { startsAt, endsAt }, sourceCommitmentId: null, blocking: true };
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

function startOf(plan: Plan, itemId: string): string | null {
  return plan.scheduled.find((entry) => entry.itemId === itemId)?.interval.startsAt ?? null;
}

function withoutProtection(request: PlanningConstraints): PlanningConstraints {
  return { ...request, items: request.items.map(({ protection: _ignored, ...rest }) => rest) };
}

/* ── 1. Protection is not priority ───────────────────────────────── */

test('a Nice protected block keeps its hour and a Must unprotected task fills in around it', () => {
  // The whole distinction, in one request. `deep-work` is the more important
  // thing and, ordered by priority alone, takes 09:00 — which is where the
  // person put their gym block. The plan is judged on both items: the Must task
  // is not punished, it is placed second.
  const request = constraints({
    items: [
      item('gym', { priority: NICE, protection: protection() }),
      item('deep-work', { priority: MUST }),
    ],
  });
  const plan = schedulePlan(request, config());

  assert.equal(startOf(plan, 'gym'), at(9), 'the protected hour was given away to a higher priority');
  assert.equal(startOf(plan, 'deep-work'), at(10), 'the Must task must still be placed, just later');

  // And the control: strip the protection and priority decides, which is what
  // makes the assertion above about protection rather than about luck.
  const unprotected = schedulePlan(withoutProtection(request), config());
  assert.equal(startOf(unprotected, 'deep-work'), at(9));
  assert.equal(startOf(unprotected, 'gym'), at(10));
});

test('a Must task is not protected merely by being a Must', () => {
  // The inverse error, and the more dangerous one: if importance implied
  // protection, every important task would be pinned to wherever the first plan
  // put it and the planner would stop rearranging the day at all.
  const request = constraints({
    items: [
      item('gym', { priority: NICE, protection: protection() }),
      item('deep-work', { priority: MUST }),
    ],
  });
  const plan = schedulePlan(request, config());
  const metrics = computePlanQualityMetrics({ plan, availableMinutes: 480, items: request.items });

  assert.equal(metrics.protectedCount, 1, 'only the item that declared a protection is protected');
  assert.equal(metrics.protectedRetainedCount, 1);
  assert.equal(metrics.protectedReleasedCount, 0);
  assert.equal(metrics.protectedShiftMinutes, 0);
  assert.equal(isProtected(request.items[1]!), false, 'priority 3 is not a protection');
});

/* ── 2. Feasible protection is kept; a hard constraint still moves it ── */

test('protected time stays exactly where it is when it is still feasible', () => {
  const request = constraints({
    items: [item('gym', { protection: protection() }), item('a'), item('b')],
  });
  const plan = schedulePlan(request, config());
  assert.equal(startOf(plan, 'gym'), at(9));

  // Feasible means feasible *this* run. Re-planning the identical request keeps
  // it, which is the property a regeneration depends on.
  assert.equal(startOf(schedulePlan(request, config()), 'gym'), at(9));
});

test('a newly added meeting beats protected gym time, and the gym block moves', () => {
  // Tier 1 of the hierarchy against tier 4. The meeting is a blocking fixed
  // event: the gym block is never offered the run it occupies, so "protected"
  // loses without anything having to decide that it should.
  const request = constraints({
    fixedEvents: [fixedEvent('m-1', at(9), at(10))],
    items: [item('gym', { protection: protection() })],
  });
  const plan = schedulePlan(request, config());

  assert.equal(startOf(plan, 'gym'), at(10), 'a protected block must yield to a hard constraint');
  const metrics = computePlanQualityMetrics({ plan, availableMinutes: 480, items: request.items });
  assert.equal(metrics.protectedRetainedCount, 0);
  assert.equal(metrics.protectedReleasedCount, 1, 'a protected block that moved was released');
  assert.equal(metrics.protectedShiftMinutes, 60);
});

test('with hard validity equal, the plan the scheduler produces has the lower protected churn', () => {
  /* Two plans, both hard-valid over the same request: the one this scheduler
   * produces, and the one it produces when the protection is taken away — which
   * is a perfectly legal arrangement of the same day, just a different one. The
   * comparison is on the shared metric, so it says what the criterion says
   * rather than restating an interval the implementation chose. */
  const request = constraints({
    items: [
      item('gym', { priority: NICE, protection: protection() }),
      item('deep-work', { priority: MUST }),
      item('errand', { priority: MUST }),
    ],
  });
  const chosen = schedulePlan(request, config());
  const alternative = schedulePlan(withoutProtection(request), config());

  // Equal hard validity: both place every item, and neither reports a thing.
  assert.equal(chosen.unscheduled.length, 0);
  assert.equal(alternative.unscheduled.length, 0);
  assert.deepEqual(chosen.constraintReasons, []);
  assert.deepEqual(alternative.constraintReasons, []);

  const churnOf = (plan: Plan): number => computePlanQualityMetrics({
    plan,
    availableMinutes: 480,
    items: request.items,
  }).protectedShiftMinutes;

  assert.ok(
    churnOf(chosen) < churnOf(alternative),
    `expected lower protected churn than the unprotected arrangement; got ${churnOf(chosen)} vs ${churnOf(alternative)}`,
  );
  assert.equal(churnOf(chosen), 0);
});

/* ── 3. The max-shift bound ──────────────────────────────────────── */

test('maxShiftMinutes is never silently exceeded, over every shape of day', () => {
  /* Asked of the *plan*, not of the policy. Every combination below either
   * places the protected item within its bound or reports it — there is no
   * third outcome, and a placement one minute outside the bound fails here
   * whatever the code that produced it believed. */
  const bounds = [0, 15, 30, 60, 120, 240];
  const obstacles: Array<readonly FixedEvent[]> = [
    [],
    [fixedEvent('m', at(9), at(10))],
    [fixedEvent('m', at(9), at(11))],
    [fixedEvent('m', at(8), at(13))],
    [fixedEvent('m', at(9), at(10)), fixedEvent('n', at(11), at(12))],
  ];
  let placements = 0;
  let refusals = 0;

  for (const maxShiftMinutes of bounds) {
    for (const fixedEvents of obstacles) {
      const protectedItem = item('gym', { protection: protection({ maxShiftMinutes }) });
      const request = constraints({ fixedEvents, items: [protectedItem, item('filler')] });
      const plan = schedulePlan(request, config());

      const placed = startOf(plan, 'gym');
      if (placed === null) {
        refusals += 1;
        const entry = plan.unscheduled.find((row) => row.itemId === 'gym');
        assert.ok(entry, 'an item in neither list is the failure the partition exists against');
        assert.equal(
          entry.reason.code,
          'PROTECTED_SHIFT_EXCEEDED',
          'a bounded protected item that cannot be placed must say why, not fall back to "your day is full"',
        );
        continue;
      }
      placements += 1;
      assert.equal(
        withinMaxShift(protectedItem, Date.parse(placed)),
        true,
        `gym was placed at ${placed}, outside a ${maxShiftMinutes}-minute bound around 09:00`,
      );
    }
  }

  // Neither branch may be vacuous: a sweep that only ever placed, or only ever
  // refused, would pass against a scheduler that had stopped doing the other.
  assert.ok(placements > 0, 'no placement was exercised');
  assert.ok(refusals > 0, 'no refusal was exercised');
});

test('an infeasible max-shift is reported, never resolved by moving further', () => {
  const protectedItem = item('gym', { protection: protection({ maxShiftMinutes: 30 }) });
  const request = constraints({
    // 08:30–10:30 leaves nothing within half an hour of 09:00, while 11:00
    // onwards is wide open — which is exactly the placement that must not happen.
    fixedEvents: [fixedEvent('m-1', at(8, 30), at(10, 30))],
    items: [protectedItem],
  });
  const plan = schedulePlan(request, config());

  assert.equal(plan.scheduled.length, 0, 'the bound was exceeded rather than reported');
  const entry = plan.unscheduled.find((row) => row.itemId === 'gym');
  assert.ok(entry);
  assert.equal(entry.reason.code, 'PROTECTED_SHIFT_EXCEEDED');
  assert.match(entry.reason.detail, /maximum shift/, 'the reason must name the bound, not the day');
  assert.equal(entry.reason.detail.includes('gym'), false, 'a reason detail carries no caller-chosen id');

  const metrics = computePlanQualityMetrics({ plan, availableMinutes: 480, items: request.items });
  assert.equal(metrics.protectedCount, 1);
  assert.equal(metrics.protectedReleasedCount, 1, 'an unscheduled protected block is a release');
  assert.equal(metrics.protectedShiftMinutes, 0, 'it did not move a distance; it is not there');
});

test('a bound of zero pins the block, and a day that cannot honour it says so', () => {
  const kept = schedulePlan(
    constraints({ items: [item('gym', { protection: protection({ maxShiftMinutes: 0 }) })] }),
    config(),
  );
  assert.equal(startOf(kept, 'gym'), at(9));

  const refused = schedulePlan(
    constraints({
      fixedEvents: [fixedEvent('m-1', at(9), at(10))],
      items: [item('gym', { protection: protection({ maxShiftMinutes: 0 }) })],
    }),
    config(),
  );
  assert.equal(refused.unscheduled[0]?.reason.code, 'PROTECTED_SHIFT_EXCEEDED');
});

test('a bound the arithmetic cannot use is reported, never repaired into "move it anywhere"', () => {
  for (const maxShiftMinutes of [-30, Number.NaN]) {
    const plan = schedulePlan(
      constraints({ items: [item('gym', { protection: protection({ maxShiftMinutes }) })] }),
      config(),
    );
    assert.equal(plan.scheduled.length, 0, `a ${String(maxShiftMinutes)} bound must not become no bound`);
    assert.equal(plan.unscheduled[0]?.reason.code, 'PROTECTED_SHIFT_EXCEEDED');
  }
});

test('a bound without a preferred interval constrains nothing; the item is still protected', () => {
  // A standing policy — #520's habit flexibility, declared before the
  // occurrence has ever been placed. There is no anchor to measure a shift
  // from, so refusing it would refuse an item for having a rule.
  const protectedItem = item('gym', {
    protection: protection({ preferredInterval: null, maxShiftMinutes: 15 }),
  });
  assert.equal(protectedStartBoundsMs(protectedItem), null);
  assert.equal(retainedStartMs(protectedItem), null);

  const request = constraints({ items: [protectedItem] });
  const plan = schedulePlan(request, config());
  assert.equal(startOf(plan, 'gym'), at(9), 'it is placed normally');

  const metrics = computePlanQualityMetrics({ plan, availableMinutes: 480, items: request.items });
  assert.equal(metrics.protectedCount, 1, 'it is protected');
  assert.equal(metrics.protectedRetainedCount, 0, 'but it had nothing to retain');
  assert.equal(metrics.protectedReleasedCount, 0, 'and so it released nothing either');
});

/* ── 4. Buffers are a separate thing and stay one ────────────────── */

test('buffer semantics are unchanged by protection: the reservation is the effort widened, no more', () => {
  const buffered = item('gym', {
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 30,
    protection: protection({ preferredInterval: interval(10, 11) }),
  });
  const plan = schedulePlan(constraints({ items: [buffered] }), config());
  const placed = plan.scheduled.find((entry) => entry.itemId === 'gym');
  assert.ok(placed);

  assert.equal(placed.interval.startsAt, at(10), 'the protected effort start is retained');
  assert.equal(placed.interval.endsAt, at(11));
  // Re-derived from the item's own buffers rather than copied from the plan: a
  // protection that had begun widening reservations would show up right here.
  assert.equal(placed.reservedInterval.startsAt, at(9, 45));
  assert.equal(placed.reservedInterval.endsAt, at(11, 30));
});

test('a protected block with buffers is bounded on its effort start, not on its reservation', () => {
  // The bound is a statement about where the thing *is*, and a user reads that
  // off the effort. Measuring it on the reserved span would make an unrelated
  // buffer edit read as a shift and refuse a placement that never moved.
  const buffered = item('gym', {
    bufferBeforeMinutes: 60,
    bufferAfterMinutes: 60,
    protection: protection({ preferredInterval: interval(11, 12), maxShiftMinutes: 0 }),
  });
  const plan = schedulePlan(constraints({ items: [buffered] }), config());
  const placed = plan.scheduled.find((entry) => entry.itemId === 'gym');
  assert.ok(placed, 'an hour of buffer either side fits inside 09:00–17:00 and must not be refused');
  assert.equal(placed.interval.startsAt, at(11));
  assert.equal(placed.reservedInterval.startsAt, at(10));
});

test('an unprotected item with buffers plans exactly as it did before protection existed', () => {
  const plain = item('a', { bufferBeforeMinutes: 15, bufferAfterMinutes: 15 });
  const plan = schedulePlan(constraints({ items: [plain] }), config());
  const placed = plan.scheduled.find((entry) => entry.itemId === 'a');
  assert.ok(placed);
  assert.equal(placed.interval.startsAt, at(9, 15), 'the before-buffer still opens inside the window');
  assert.equal(placed.reservedInterval.startsAt, at(9));
  assert.equal(placed.reservedInterval.endsAt, at(10, 30));
});

/* ── 5. Determinism and the digest ───────────────────────────────── */

test('replay is deterministic: the same protected request produces the same plan, structurally', () => {
  const request = constraints({
    fixedEvents: [fixedEvent('m-1', at(11), at(12))],
    items: [
      item('gym', { priority: NICE, protection: protection({ maxShiftMinutes: 60 }) }),
      item('deep-work', { priority: MUST }),
      item('errand', { priority: NICE, protection: protection({ preferredInterval: interval(14, 15) }) }),
      item('stuck', { protection: protection({ preferredInterval: interval(11, 12), maxShiftMinutes: 0 }) }),
    ],
  });

  const first = schedulePlan(request, config());
  const second = schedulePlan(request, config());
  assert.deepEqual(second, first, 'two runs of one request disagreed');
  assert.equal(second.inputDigest, first.inputDigest);

  // And the input order of the items does not change the answer, which is what
  // makes "the same request" mean the same thing to two call sites.
  const reordered = schedulePlan({ ...request, items: request.items.slice().reverse() }, config());
  assert.deepEqual(reordered.scheduled, first.scheduled);
  assert.equal(reordered.inputDigest, first.inputDigest);
});

test('the digest sees a protection, and an unprotected request hashes as it always did', () => {
  const plain = constraints({ items: [item('gym')] });
  const guarded = constraints({ items: [item('gym', { protection: protection() })] });
  const shifted = constraints({ items: [item('gym', { protection: protection({ maxShiftMinutes: 30 }) })] });

  assert.notEqual(planningInputDigest(guarded, config()), planningInputDigest(plain, config()));
  assert.notEqual(planningInputDigest(shifted, config()), planningInputDigest(guarded, config()));
  // An explicit `null` protection is the absence of one and must not fork the
  // digest of an otherwise identical request.
  assert.equal(
    planningInputDigest(constraints({ items: [item('gym', { protection: null })] }), config()),
    planningInputDigest(plain, config()),
  );
});

/* ── 6. The retention tier, directly ─────────────────────────────── */

test('the retention tier orders a retainable protected item first and decides nothing else', () => {
  const retainable = item('gym', { protection: protection() });
  const policyOnly = item('habit', { protection: protection({ preferredInterval: null }) });
  const plain = item('a');

  assert.ok(compareProtectionRetention(retainable, plain) < 0);
  assert.ok(compareProtectionRetention(plain, retainable) > 0);
  // Two of a kind are a tie, so `comparePlanOrder` — priority, deadline, id —
  // decides them. The tier adds one distinction and no more.
  assert.equal(compareProtectionRetention(retainable, item('b', { protection: protection() })), 0);
  assert.equal(compareProtectionRetention(plain, item('b')), 0);
  // Protected in principle, with nothing to keep: there is no placement to be
  // offered first, so it is ordinary work as far as this tier is concerned.
  assert.equal(compareProtectionRetention(policyOnly, plain), 0);
});

test('a protected placement off the slot grid is retained rather than rounded onto it', () => {
  // 07:10 is where the person dropped it. Rounding to the grid on every
  // regeneration would be churn produced by the mechanism meant to stop it.
  const request = constraints({
    workingWindows: [workingWindow({ startMinute: 420, endMinute: 1020 })],
    items: [item('gym', { protection: protection({ preferredInterval: { startsAt: at(7, 10), endsAt: at(8, 10) } }) })],
  });
  const plan = schedulePlan(request, config());
  assert.equal(startOf(plan, 'gym'), at(7, 10));
});

/* ── 7. The block projection: scope, precedence, idempotency ─────── */

function block(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    blockId: 'block:commitment:gym',
    scopeId: SCOPE,
    source: { kind: 'commitment', id: 'gym' },
    mobility: 'flexible',
    durationMinutes: 60,
    placement: { earliestStartAt: null, latestEndAt: null, preferredWindows: [] },
    currentInterval: interval(9, 10),
    lastPlacedBy: 'user',
    lastPlanGeneration: 1,
    protection: protection(),
    ...overrides,
  };
}

test('a protection recorded on a block re-enters the next request as the item it belongs to', () => {
  const request = constraints({ items: [item('gym'), item('a')] });
  const projected = projectBlockProtectionIntoPlanningConstraints(request, [block()]);

  assert.deepEqual(projected.items[0]!.protection, protection());
  assert.equal(projected.items[1]!.protection ?? null, null, 'no other item is touched');
  // And the projection is what makes the retention survive a regeneration.
  assert.equal(startOf(schedulePlan(projected, config()), 'gym'), at(9));
});

test('the projection is idempotent and leaves a request it has nothing to say about alone', () => {
  const request = constraints({ items: [item('gym')] });
  const once = projectBlockProtectionIntoPlanningConstraints(request, [block()]);
  const twice = projectBlockProtectionIntoPlanningConstraints(once, [block()]);
  assert.deepEqual(twice, once);
  assert.equal(planningInputDigest(twice, config()), planningInputDigest(once, config()));

  // Nothing to apply: the same object back, so a caller cannot tell a no-op
  // apart from not having called it — which is what keeps the digest stable.
  assert.equal(projectBlockProtectionIntoPlanningConstraints(request, []), request);
  assert.equal(projectBlockProtectionIntoPlanningConstraints(request, null), request);
});

test('one account\'s protected hour never reaches another account\'s day', () => {
  // Block ids are unique inside a scope and not across accounts: two people
  // holding the same commitment id hold the same `blockId`. An unscoped join
  // would carry one person's protection into the other's plan.
  const other = block({ scopeId: 'scope-someone-else' });
  const request = constraints({ items: [item('gym')] });
  const projected = projectBlockProtectionIntoPlanningConstraints(request, [other]);

  assert.equal(projected, request, 'a block from another scope must not match');
  assert.equal(projected.items[0]!.protection ?? null, null);
});

test('an item that states its own protection outranks a stored block\'s', () => {
  const own = protection({ preferredInterval: interval(15, 16), maxShiftMinutes: 5 });
  const request = constraints({ items: [item('gym', { protection: own })] });
  const projected = projectBlockProtectionIntoPlanningConstraints(request, [block()]);
  assert.deepEqual(projected.items[0]!.protection, own);
});

test('a fixed block carries no protection forward, whatever it holds', () => {
  // Its position belongs to the source that pinned it; `ownershipOf` reads it
  // as fixed, and describing an objective about a placement the solver never
  // makes would be a claim about nothing.
  const pinned = block({ mobility: 'fixed' });
  assert.equal(ownershipOf(pinned), 'fixed');
  const request = constraints({ items: [item('gym')] });
  assert.equal(projectBlockProtectionIntoPlanningConstraints(request, [pinned]), request);
});

test('ownershipOf reads the three states the contract names', () => {
  assert.equal(ownershipOf(block()), 'protected_flexible');
  assert.equal(ownershipOf(block({ protection: null })), 'flexible');
  assert.equal(ownershipOf({ mobility: 'flexible' }), 'flexible');
  assert.equal(ownershipOf(block({ mobility: 'fixed' })), 'fixed');
});

/* ── 8. A manual move becomes the new preference ─────────────────── */

test('a successful move re-anchors a protected placement and keeps its bound', () => {
  const moved = protectionAfterMove(protection({ maxShiftMinutes: 45 }), interval(14, 15));
  assert.deepEqual(moved, {
    ownership: 'protected_flexible',
    origin: 'user',
    preferredInterval: interval(14, 15),
    maxShiftMinutes: 45,
  });

  // The bound follows the new preference rather than the old one, which is the
  // only reading that neither forgets it nor measures it from a placement the
  // person has replaced.
  const reanchored = item('gym', { protection: moved });
  assert.equal(retainedStartMs(reanchored), Date.parse(at(14)));
  assert.equal(withinMaxShift(reanchored, Date.parse(at(14, 45))), true);
  assert.equal(withinMaxShift(reanchored, Date.parse(at(15))), false);
});

test('moving an unprotected block is not a declaration that it should never move again', () => {
  assert.equal(protectionAfterMove(null, interval(14, 15)), null);
  assert.equal(protectionAfterMove(undefined, interval(14, 15)), null);
});

/* ── 9. The metrics, as figures rather than as a side effect ─────── */

test('the four protection figures count protection and nothing else', () => {
  const items = [
    item('kept', { protection: protection({ preferredInterval: interval(9, 10) }) }),
    item('moved', { protection: protection({ preferredInterval: interval(10, 11) }) }),
    item('gone', { protection: protection({ preferredInterval: interval(12, 13) }) }),
    item('policy', { protection: protection({ preferredInterval: null }) }),
    item('ordinary', { priority: MUST }),
  ];
  const plan: Plan = {
    version: '1.0.0' as never,
    schema: 'planning-v1',
    scopeId: SCOPE,
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    scheduled: [
      { itemId: 'kept', interval: interval(9, 10), reservedInterval: interval(9, 10) },
      { itemId: 'moved', interval: interval(13, 14), reservedInterval: interval(13, 14) },
      { itemId: 'policy', interval: interval(15, 16), reservedInterval: interval(15, 16) },
      { itemId: 'ordinary', interval: interval(16, 17), reservedInterval: interval(16, 17) },
    ],
    unscheduled: [{ itemId: 'gone', reason: { code: 'NO_FEASIBLE_SLOT', itemId: 'gone', detail: 'x' } }],
    constraintReasons: [],
    inputDigest: 'digest',
  };

  const metrics = computePlanQualityMetrics({ plan, availableMinutes: 480, items });
  assert.equal(metrics.protectedCount, 4);
  assert.equal(metrics.protectedRetainedCount, 1);
  assert.equal(metrics.protectedReleasedCount, 2, 'one moved and one vanished; both are releases');
  assert.equal(metrics.protectedShiftMinutes, 180, 'only the one that moved contributes a distance');

  // A caller that does not pass the items is not measuring protection, and gets
  // zeroes rather than a guess.
  const unmeasured = computePlanQualityMetrics({ plan, availableMinutes: 480 });
  assert.equal(unmeasured.protectedCount, 0);
  assert.equal(unmeasured.protectedRetainedCount, 0);
  assert.equal(unmeasured.protectedReleasedCount, 0);
  assert.equal(unmeasured.protectedShiftMinutes, 0);
});

test('protected churn is reported separately from churn against the previous plan', () => {
  // `churnMinutes` measures every item's movement between two plans; a planner
  // tuned against it would hold an ordinary task still just as happily. The two
  // figures answer different questions and must not be folded together.
  const items = [item('gym', { protection: protection({ preferredInterval: interval(9, 10) }) })];
  const planAt = (hour: number): Plan => ({
    version: '1.0.0' as never,
    schema: 'planning-v1',
    scopeId: SCOPE,
    horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
    scheduled: [{ itemId: 'gym', interval: interval(hour, hour + 1), reservedInterval: interval(hour, hour + 1) }],
    unscheduled: [],
    constraintReasons: [],
    inputDigest: 'digest',
  });

  const metrics = computePlanQualityMetrics({
    plan: planAt(11),
    previousPlan: planAt(10),
    availableMinutes: 480,
    items,
  });
  assert.equal(metrics.churnMinutes, 60, 'it moved an hour since the last plan');
  assert.equal(metrics.protectedShiftMinutes, 120, 'and sits two hours from what it was protecting');
});

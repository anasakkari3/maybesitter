/**
 * ImpactEvaluator and burst coalescing (#523, slice 1).
 *
 * The three examples the issue itself states are pinned first and verbatim —
 * calendar description edit, overlapping busy event, WHOOP payload whose
 * normalized band did not move — because they are the acceptance language of
 * the slice. Everything else pins the rules those examples rely on: the
 * metadata false-positive firewall, the burst that must decide once, and the
 * determinism both halves contract.
 *
 * Every plan view and every change here is built by hand as data, for the
 * same reason `planMetrics.test.ts` builds its plans by hand: the evaluator
 * takes a plan as data, so a suite that had to run the scheduler to get a
 * fixture would be measuring the scheduler.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  combineImpactDecisions,
  evaluateStateChangeImpact,
  coalescePlanningStateChanges,
  type ImpactEvaluationInput,
} from '../../lib/planning/replan/index.ts';
import {
  REPLAN_BURST_WINDOW_MS,
  type ChangedEntityFacts,
  type PlanImpactView,
} from '../../src/contracts/v1/replanContracts.ts';
import {
  PLANNING_STATE_CHANGE_SCHEMA_VERSION,
  type PlanningStateChange,
} from '../../src/contracts/v1/watcherContracts.ts';
import type { PlannedItem, TimeInterval } from '../../src/contracts/v1/planningContracts.ts';

/* ── Fixtures ────────────────────────────────────────────────────── */

const HORIZON = { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-10T00:00:00.000Z' };

function interval(startsAt: string, endsAt: string): TimeInterval {
  return { startsAt, endsAt };
}

/** A scheduled block at 14:00–15:00 with a 15-minute buffer each side. */
const SCHEDULED_BLOCK: PlannedItem = {
  itemId: 'item-study',
  interval: interval('2026-11-09T14:00:00.000Z', '2026-11-09T15:00:00.000Z'),
  reservedInterval: interval('2026-11-09T13:45:00.000Z', '2026-11-09T15:15:00.000Z'),
};

function planView(overrides: Partial<PlanImpactView> = {}): PlanImpactView {
  return {
    scopeId: 'scope-1',
    horizon: HORIZON,
    scheduled: [SCHEDULED_BLOCK],
    ...overrides,
  };
}

function change(overrides: Partial<PlanningStateChange> = {}): PlanningStateChange {
  return {
    schemaVersion: PLANNING_STATE_CHANGE_SCHEMA_VERSION,
    changeId: 'chg-1',
    scopeId: 'scope-1',
    source: 'calendar',
    entityId: 'event-1',
    occurredAt: '2026-11-09T08:00:00.000Z',
    changedFields: [],
    beforeDigest: 'digest-before',
    afterDigest: 'digest-after',
    provenanceRef: 'sync:run-1',
    ...overrides,
  };
}

function evaluate(
  changeOverrides: Partial<PlanningStateChange>,
  plan: PlanImpactView | null,
  entity: ChangedEntityFacts | null,
) {
  const input: ImpactEvaluationInput = { change: change(changeOverrides), plan, entity };
  return evaluateStateChangeImpact(input);
}

/* ── The issue's three examples, verbatim ────────────────────────── */

test('calendar description changed but the interval did not → NO_EFFECT', () => {
  const impact = evaluate(
    { changedFields: ['description'] },
    planView(),
    { interval: interval('2026-11-09T10:00:00.000Z', '2026-11-09T11:00:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'non_planning_fields_only');
});

test('a description edit on an event that already overlaps a block is still NO_EFFECT', () => {
  // The evaluator judges the change, not the world: the overlap was reported
  // by the change that created it, and a metadata edit cannot move an
  // interval. Firing here would re-raise yesterday's conflict per keystroke.
  const impact = evaluate(
    { changedFields: ['description'] },
    planView(),
    { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
});

test('a new busy event overlapping a scheduled block → REPLAN_REQUIRED', () => {
  const impact = evaluate(
    {
      changeId: 'chg-new-event',
      beforeDigest: null,
      changedFields: ['interval', 'blocking'],
    },
    planView(),
    // 14:30–15:30 overlaps the block's reserved interval (13:45–15:15).
    { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'REPLAN_REQUIRED');
  assert.equal(impact.reason, 'overlaps_scheduled_block');
});

test('an event landing only inside a block\'s buffer still requires a replan', () => {
  // Conflict checks compare reserved intervals — effort plus buffers — the
  // same convention the scheduler itself holds.
  const impact = evaluate(
    { changedFields: ['interval'] },
    planView(),
    { interval: interval('2026-11-09T15:00:00.000Z', '2026-11-09T15:10:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'REPLAN_REQUIRED');
});

test('a readiness payload whose normalized band did not change → NO_EFFECT', () => {
  const impact = evaluate(
    {
      source: 'readiness',
      entityId: 'whoop',
      changedFields: ['payload'],
      beforeDigest: 'band:steady',
      afterDigest: 'band:steady',
    },
    planView(),
    null,
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'digests_unchanged');
});

/* ── The remaining decision rules ────────────────────────────────── */

test('no current plan → NO_EFFECT', () => {
  const impact = evaluate(
    { changedFields: ['interval', 'blocking'] },
    null,
    { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'no_current_plan');
});

test('a change for a different scope does not touch this scope\'s plan', () => {
  const impact = evaluate(
    { scopeId: 'scope-2', changedFields: ['interval', 'blocking'] },
    planView(),
    { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'different_scope');
});

test('a blocking event entirely outside the horizon → NO_EFFECT', () => {
  const impact = evaluate(
    { changedFields: ['interval', 'blocking'] },
    planView(),
    { interval: interval('2026-11-12T14:00:00.000Z', '2026-11-12T15:00:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'outside_horizon');
});

test('a busy event that merely abuts a block does not overlap it → PLAN_STALE', () => {
  // Half-open intervals: [15:15, 16:00) shares an instant with the block's
  // reserved end and no more. Capacity still changed, so the plan is stale.
  const impact = evaluate(
    { changedFields: ['interval', 'blocking'] },
    planView(),
    { interval: interval('2026-11-09T15:15:00.000Z', '2026-11-09T16:00:00.000Z'), blocking: true },
  );
  assert.equal(impact.decision, 'PLAN_STALE');
  assert.equal(impact.reason, 'planner_input_changed');
});

test('a cancelled event frees capacity → PLAN_STALE, never REPLAN_REQUIRED', () => {
  // `interval: null` is the after-state of a deletion: no placement is
  // contradicted, but the planner's inputs moved.
  const impact = evaluate(
    { changedFields: ['cancelled'] },
    planView(),
    { interval: null, blocking: false },
  );
  assert.equal(impact.decision, 'PLAN_STALE');
  assert.equal(impact.reason, 'planner_input_changed');
});

/* ── A removal is judged by where the removed time was (#611, #645 review) ── */

test('a removal whose previous interval lies outside the horizon → NO_EFFECT', () => {
  // Next week's meeting, cancelled. It frees no time today.
  const impact = evaluate(
    { changedFields: ['interval', 'blocking'] },
    planView(),
    { interval: null, blocking: false, previousInterval: interval('2026-11-16T14:00:00.000Z', '2026-11-16T15:00:00.000Z') },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'outside_horizon');
});

test('a removal whose previous interval lies inside the horizon still frees capacity → PLAN_STALE', () => {
  const impact = evaluate(
    { changedFields: ['interval', 'blocking'] },
    planView(),
    { interval: null, blocking: false, previousInterval: interval('2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z') },
  );
  assert.equal(impact.decision, 'PLAN_STALE');
});

test('a removal whose previous interval straddles the horizon edge is inside it → PLAN_STALE', () => {
  const impact = evaluate(
    { changedFields: ['interval', 'blocking'] },
    planView(),
    { interval: null, blocking: false, previousInterval: interval('2026-11-08T23:00:00.000Z', '2026-11-09T01:00:00.000Z') },
  );
  assert.equal(impact.decision, 'PLAN_STALE');
});

test('an entity that left the horizon freed time inside it → PLAN_STALE, not outside_horizon', () => {
  // Its span now is next week; its span before was today.
  const impact = evaluate(
    { changedFields: ['interval'] },
    planView(),
    {
      interval: interval('2026-11-16T09:00:00.000Z', '2026-11-16T10:00:00.000Z'),
      blocking: true,
      previousInterval: interval('2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z'),
    },
  );
  assert.equal(impact.decision, 'PLAN_STALE');
});

test('an entity moved within next week (both spans outside) → NO_EFFECT', () => {
  const impact = evaluate(
    { changedFields: ['interval'] },
    planView(),
    {
      interval: interval('2026-11-16T11:00:00.000Z', '2026-11-16T12:00:00.000Z'),
      blocking: true,
      previousInterval: interval('2026-11-16T09:00:00.000Z', '2026-11-16T10:00:00.000Z'),
    },
  );
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'outside_horizon');
});

/* ── Time freed only in the past (#611, #645 review round 2) ────────── */

function evaluateAt(now: string | undefined, entity: ChangedEntityFacts | null) {
  return evaluateStateChangeImpact({ change: change({ changedFields: ['interval', 'blocking'] }), plan: planView(), entity, ...(now === undefined ? {} : { now }) });
}

const MORNING_MEETING = interval('2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z');

test('a removal whose previous interval ended before now → NO_EFFECT, freed_time_in_past', () => {
  const impact = evaluateAt('2026-11-09T12:00:00.000Z', { interval: null, blocking: false, previousInterval: MORNING_MEETING });
  assert.equal(impact.decision, 'NO_EFFECT');
  assert.equal(impact.reason, 'freed_time_in_past');
});

test('a removal whose previous interval ended exactly now → NO_EFFECT (half-open)', () => {
  const impact = evaluateAt('2026-11-09T10:00:00.000Z', { interval: null, blocking: false, previousInterval: MORNING_MEETING });
  assert.equal(impact.reason, 'freed_time_in_past');
});

test('a removal of a meeting still in progress, or still ahead, frees time that can be used → PLAN_STALE', () => {
  assert.equal(evaluateAt('2026-11-09T09:30:00.000Z', { interval: null, blocking: false, previousInterval: MORNING_MEETING }).decision, 'PLAN_STALE');
  assert.equal(evaluateAt('2026-11-09T08:00:00.000Z', { interval: null, blocking: false, previousInterval: MORNING_MEETING }).decision, 'PLAN_STALE');
});

test('without an instant to judge at, or without a previous interval, the rule does not apply → PLAN_STALE', () => {
  assert.equal(evaluateAt(undefined, { interval: null, blocking: false, previousInterval: MORNING_MEETING }).decision, 'PLAN_STALE');
  assert.equal(evaluateAt('2026-11-09T12:00:00.000Z', { interval: null, blocking: false }).decision, 'PLAN_STALE');
});

test('an entity that still blocks is not a removal, even when its previous interval has ended → judged as usual', () => {
  // Same id, its end moved from 10:00 to 16:00, judged at 12:00: it now sits
  // on the 14:00 block, and that is a contradiction, not freed time.
  const impact = evaluateAt('2026-11-09T12:00:00.000Z', {
    interval: interval('2026-11-09T09:00:00.000Z', '2026-11-09T16:00:00.000Z'),
    blocking: true,
    previousInterval: MORNING_MEETING,
  });
  assert.equal(impact.decision, 'REPLAN_REQUIRED');
});

test('the mirror is not applied: a meeting entered after the fact on a past placement still → REPLAN_REQUIRED', () => {
  // 14:00–15:00 on the scheduled block, judged at 18:00. It can sit on a
  // placement of a pending offer, which only a re-solve replaces (#636).
  const impact = evaluateAt('2026-11-09T18:00:00.000Z', { interval: interval('2026-11-09T14:00:00.000Z', '2026-11-09T15:00:00.000Z'), blocking: true });
  assert.equal(impact.decision, 'REPLAN_REQUIRED');
});

test('a changed field nobody recognises falls through to PLAN_STALE', () => {
  // Unknown is not metadata: dismissing a field not on the list is how a real
  // change gets silenced by a stale allow-list.
  const impact = evaluate(
    { changedFields: ['some_future_field'] },
    planView(),
    null,
  );
  assert.equal(impact.decision, 'PLAN_STALE');
});

test('an empty changedFields declares nothing and is not metadata', () => {
  const impact = evaluate({}, planView(), null);
  assert.equal(impact.decision, 'PLAN_STALE');
});

/* ── Non-planning metadata never reaches the planner ─────────────── */

test('non-planning metadata changes produce zero planner-facing decisions', () => {
  const metadataFields = ['title', 'description', 'location', 'attendees', 'notes', 'color', 'url', 'etag'];
  const decisions = metadataFields.map((field) =>
    evaluate(
      { changeId: `chg-meta-${field}`, changedFields: [field] },
      planView(),
      { interval: interval('2026-11-09T10:00:00.000Z', '2026-11-09T11:00:00.000Z'), blocking: true },
    ));
  // The issue's criterion, counted: nothing but NO_EFFECT may come back.
  assert.equal(decisions.filter((impact) => impact.decision !== 'NO_EFFECT').length, 0);
  for (const impact of decisions) assert.equal(impact.reason, 'non_planning_fields_only');

  // A metadata-only mix across several fields is still metadata-only.
  const mixed = evaluate(
    { changedFields: ['title', 'description', 'location'] },
    planView(),
    null,
  );
  assert.equal(mixed.decision, 'NO_EFFECT');

  // But one planner-relevant field among them defeats the firewall.
  const contaminated = evaluate(
    { changedFields: ['title', 'deadlineAt'] },
    planView(),
    null,
  );
  assert.equal(contaminated.decision, 'PLAN_STALE');
});

/* ── Determinism ─────────────────────────────────────────────────── */

test('the evaluator is deterministic: same inputs, identical decision object', () => {
  const input: ImpactEvaluationInput = {
    change: change({ changedFields: ['interval', 'blocking'] }),
    plan: planView(),
    entity: { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  };
  assert.deepEqual(evaluateStateChangeImpact(input), evaluateStateChangeImpact(input));
});

test('combineImpactDecisions takes the most severe tier, and NO_EFFECT over nothing', () => {
  assert.equal(combineImpactDecisions([]), 'NO_EFFECT');
  const noEffect = evaluate({ changedFields: ['title'] }, planView(), null);
  const stale = evaluate({}, planView(), null);
  const required = evaluate(
    { changedFields: ['interval'] },
    planView(),
    { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  );
  assert.equal(combineImpactDecisions([noEffect, stale]), 'PLAN_STALE');
  assert.equal(combineImpactDecisions([stale, noEffect, required]), 'REPLAN_REQUIRED');
  assert.equal(combineImpactDecisions([required, stale]), 'REPLAN_REQUIRED');
});

/* ── Burst coalescing ────────────────────────────────────────────── */

/** One provider refresh fanned out into five notifications, ten seconds apart. */
function providerRefreshBurst(): PlanningStateChange[] {
  return [0, 1, 2, 3, 4].map((index) => change({
    changeId: `chg-sync-${index}`,
    occurredAt: `2026-11-09T08:00:${String(index * 10).padStart(2, '0')}.000Z`,
    changedFields: ['interval'],
    beforeDigest: null,
    afterDigest: 'digest-after',
    provenanceRef: 'sync:refresh-1',
  }));
}

test('five sync notifications of one provider refresh coalesce to one decision', () => {
  const burst = providerRefreshBurst();
  const groups = coalescePlanningStateChanges(burst);

  assert.equal(groups.length, 1);
  const [group] = groups;
  assert.equal(group.coalescedCount, 5);
  assert.deepEqual(group.changeIds, burst.map((member) => member.changeId));
  // The representative is the latest change — the newest declared state.
  assert.equal(group.representative.changeId, 'chg-sync-4');
  assert.equal(group.firstOccurredAt, '2026-11-09T08:00:00.000Z');
  assert.equal(group.lastOccurredAt, '2026-11-09T08:00:40.000Z');

  // One group is evaluated once: five changes in, one decision out.
  const impacts = groups.map((entry) => evaluateStateChangeImpact({
    change: entry.representative,
    plan: planView(),
    entity: { interval: interval('2026-11-09T14:30:00.000Z', '2026-11-09T15:30:00.000Z'), blocking: true },
  }));
  assert.equal(impacts.length, 1);
  assert.equal(combineImpactDecisions(impacts), 'REPLAN_REQUIRED');
});

test('a change past the bounded window opens a new group', () => {
  const burst = providerRefreshBurst();
  const late = change({
    changeId: 'chg-sync-late',
    occurredAt: '2026-11-09T08:02:00.000Z',
    changedFields: ['interval'],
    afterDigest: 'digest-after',
  });
  const groups = coalescePlanningStateChanges([...burst, late]);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].coalescedCount, 5);
  assert.equal(groups[1].coalescedCount, 1);
  assert.equal(groups[1].representative.changeId, 'chg-sync-late');
});

test('a redelivered change is idempotent at any distance', () => {
  const original = change({ changeId: 'chg-dup', occurredAt: '2026-11-09T08:00:00.000Z' });
  const redelivery = change({ changeId: 'chg-dup', occurredAt: '2026-11-09T23:59:00.000Z' });
  // Hours apart — far outside the window — and still one group, because an id
  // is an identity, not a burst member.
  const groups = coalescePlanningStateChanges([original, redelivery]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].coalescedCount, 1);
  assert.equal(groups[0].representative.changeId, 'chg-dup');
});

test('a different resulting state is a different burst, even inside the window', () => {
  const first = change({ changeId: 'chg-a', occurredAt: '2026-11-09T08:00:00.000Z', afterDigest: 'state-a' });
  const second = change({ changeId: 'chg-b', occurredAt: '2026-11-09T08:00:05.000Z', afterDigest: 'state-b' });
  const groups = coalescePlanningStateChanges([first, second]);
  assert.equal(groups.length, 2);
});

test('different scopes or entities never coalesce', () => {
  const base = { occurredAt: '2026-11-09T08:00:00.000Z', afterDigest: 'digest-after' };
  const groups = coalescePlanningStateChanges([
    change({ ...base, changeId: 'chg-1', entityId: 'event-1' }),
    change({ ...base, changeId: 'chg-2', entityId: 'event-2' }),
    change({ ...base, changeId: 'chg-3', entityId: 'event-1', scopeId: 'scope-2' }),
  ]);
  assert.equal(groups.length, 3);
});

test('coalescing is order-independent', () => {
  const burst = providerRefreshBurst();
  const shuffled = [burst[3], burst[0], burst[4], burst[1], burst[2]];
  assert.deepEqual(coalescePlanningStateChanges(shuffled), coalescePlanningStateChanges(burst));
});

test('the default window is the contract\'s one minute', () => {
  const first = change({ changeId: 'chg-w1', occurredAt: '2026-11-09T08:00:00.000Z' });
  const insideEdge = change({ changeId: 'chg-w2', occurredAt: '2026-11-09T08:01:00.000Z' });
  const pastEdge = change({ changeId: 'chg-w3', occurredAt: '2026-11-09T08:01:00.001Z' });
  assert.equal(coalescePlanningStateChanges([first, insideEdge]).length, 1);
  assert.equal(coalescePlanningStateChanges([first, pastEdge]).length, 2);
  assert.equal(REPLAN_BURST_WINDOW_MS, 60_000);
});

test('a malformed window is refused rather than coalescing with NaN', () => {
  assert.throws(() => coalescePlanningStateChanges([], { windowMs: Number.NaN }), TypeError);
  assert.throws(() => coalescePlanningStateChanges([], { windowMs: -1 }), TypeError);
});

test('changes from different sources, or whose ids only concatenate alike, never share a burst (#605)', () => {
  const base = providerRefreshBurst()[0]!;
  const calendar = { ...base, changeId: 'chg-cal', source: 'calendar' as const, entityId: 'x1', afterDigest: 'd' };
  const commitment = { ...calendar, changeId: 'chg-cmt', source: 'commitment' as const };
  assert.equal(coalescePlanningStateChanges([calendar, commitment]).length, 2, 'one entity id in two sources is two entities');

  const split = { ...calendar, changeId: 'chg-split-a', entityId: 'ab', afterDigest: 'c' };
  const shifted = { ...calendar, changeId: 'chg-split-b', entityId: 'a', afterDigest: 'bc' };
  assert.equal(coalescePlanningStateChanges([split, shifted]).length, 2, 'key parts must not run together');
});

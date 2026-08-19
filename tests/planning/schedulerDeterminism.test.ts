/**
 * Determinism and the input digest (Sprint 07, issue #30).
 *
 * "Same inputs and config produce the same plan" is the acceptance criterion
 * that is easiest to satisfy accidentally and hardest to satisfy honestly. Two
 * calls in the same process, with the same array in the same order, will agree
 * for a scheduler that iterates a `Map` and breaks ties by insertion order —
 * and that scheduler produces a different plan the moment a caller builds its
 * request from a different query. So the assertions here vary the things that
 * must *not* matter:
 *
 *  - the order of every input array, including nested `dependsOn` lists;
 *  - the order the object keys were written in at the call site;
 *  - which of two structurally identical requests was constructed first.
 *
 * And they pin the thing that must: the digest changes when any meaningful
 * field changes. A digest that were merely stable would be perfectly stable at
 * the constant `"0"`, and every replay check built on it would pass while
 * comparing nothing.
 *
 * Arrays are reversed rather than randomly shuffled. A random order would make
 * any failure here unreproducible, which is a poor property for the file whose
 * subject is reproducibility.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalPlanningInput,
  planningInputDigest,
  schedulePlan,
} from '../../lib/planning/scheduler/index.ts';
import type {
  FixedEvent,
  PlanningConfig,
  PlanningConstraints,
  PlanningItem,
  WorkingWindow,
} from '../../src/contracts/v1/planningContracts.ts';

const HORIZON_START = '2026-08-17T00:00:00.000Z';
const HORIZON_END = '2026-08-18T00:00:00.000Z';

function config(overrides: Partial<PlanningConfig> = {}): PlanningConfig {
  return { slotMinutes: 15, foldPolicy: 'earliest', resourceDependenciesOrder: false, ...overrides };
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

const WINDOWS: readonly WorkingWindow[] = [
  { windowId: 'w-mon', weekday: 1, startMinute: 540, endMinute: 780, timezone: 'UTC' },
  { windowId: 'w-mon-pm', weekday: 1, startMinute: 840, endMinute: 1020, timezone: 'UTC' },
];

const EVENTS: readonly FixedEvent[] = [
  {
    eventId: 'm-1',
    interval: { startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T10:30:00.000Z' },
    sourceCommitmentId: 'commitment-9',
    blocking: true,
  },
  {
    eventId: 'm-2',
    interval: { startsAt: '2026-08-17T15:00:00.000Z', endsAt: '2026-08-17T15:45:00.000Z' },
    sourceCommitmentId: null,
    blocking: true,
  },
];

const ITEMS: readonly PlanningItem[] = [
  item('alpha', { priority: 7, bufferAfterMinutes: 15 }),
  item('beta', { priority: 7, deadlineAt: '2026-08-17T17:00:00.000Z' }),
  item('gamma', {
    priority: 3,
    dependsOn: [
      { dependsOnItemId: 'alpha', kind: 'temporal' },
      { dependsOnItemId: 'beta', kind: 'informational' },
    ],
  }),
  item('delta', { priority: 9, effort: { kind: 'known', minutes: 120 } }),
  item('epsilon', { effort: { kind: 'unknown' } }),
];

const BASE: PlanningConstraints = {
  scopeId: 'scope-determinism',
  timezone: 'UTC',
  horizon: { startsAt: HORIZON_START, endsAt: HORIZON_END },
  workingWindows: WINDOWS,
  fixedEvents: EVENTS,
  items: ITEMS,
};

function planJson(constraints: PlanningConstraints, planningConfig = config()): string {
  return JSON.stringify(schedulePlan(constraints, planningConfig));
}

/* ── The plan ───────────────────────────────────────────────────── */

test('two runs over the same request are byte-identical', () => {
  assert.equal(planJson(BASE), planJson(BASE));
});

test('the request is not mutated by planning it', () => {
  // A scheduler that sorted `constraints.items` in place would be deterministic
  // on its own output and would silently reorder its caller's data, which is
  // how the *next* caller ends up with a different answer.
  const before = JSON.stringify(BASE);
  schedulePlan(BASE, config());
  assert.equal(JSON.stringify(BASE), before);
});

test('reversing every input array changes nothing about the plan', () => {
  const reversed: PlanningConstraints = {
    ...BASE,
    workingWindows: WINDOWS.slice().reverse(),
    fixedEvents: EVENTS.slice().reverse(),
    items: ITEMS.slice().reverse().map((entry) => ({
      ...entry,
      dependsOn: entry.dependsOn.slice().reverse(),
    })),
  };

  assert.equal(planJson(reversed), planJson(BASE));
  assert.equal(planningInputDigest(reversed, config()), planningInputDigest(BASE, config()));
});

test('the plan does not depend on the order the object keys were written in', () => {
  // Written back-to-front on purpose. `JSON.stringify` emits keys in insertion
  // order, so a digest built with it would differ here while the two requests
  // are the same request — and `sameInputDigest` would then read false forever
  // and every replay assertion resting on it would pass by never comparing.
  const keyShuffled: PlanningConstraints = {
    items: ITEMS.map((entry) => ({
      bufferAfterMinutes: entry.bufferAfterMinutes,
      bufferBeforeMinutes: entry.bufferBeforeMinutes,
      dependsOn: entry.dependsOn.map((edge) => ({
        kind: edge.kind,
        dependsOnItemId: edge.dependsOnItemId,
      })),
      priority: entry.priority,
      deadlineAt: entry.deadlineAt,
      earliestStartAt: entry.earliestStartAt,
      effort: entry.effort,
      title: entry.title,
      itemId: entry.itemId,
    })),
    fixedEvents: EVENTS.map((entry) => ({
      blocking: entry.blocking,
      sourceCommitmentId: entry.sourceCommitmentId,
      interval: { endsAt: entry.interval.endsAt, startsAt: entry.interval.startsAt },
      eventId: entry.eventId,
    })),
    workingWindows: WINDOWS.map((entry) => ({
      timezone: entry.timezone,
      endMinute: entry.endMinute,
      startMinute: entry.startMinute,
      weekday: entry.weekday,
      windowId: entry.windowId,
    })),
    horizon: { endsAt: BASE.horizon.endsAt, startsAt: BASE.horizon.startsAt },
    timezone: BASE.timezone,
    scopeId: BASE.scopeId,
  };

  assert.equal(planJson(keyShuffled), planJson(BASE));
  assert.equal(canonicalPlanningInput(keyShuffled, config()), canonicalPlanningInput(BASE, config()));
});

test('an item with several ordering prerequisites does not leak their declared order', () => {
  // The regression this file previously missed. `gamma` above has two edges but
  // only one *ordering* edge, so nothing had to be chosen between — and the
  // blocked-chain walk picked its next hop with a bare `.find` over
  // `dependsOn` in declaration order. The result was two plans whose reason
  // details differed while the digest reported the inputs identical, which
  // inverts the one property the digest exists to provide: `sameInputDigest`
  // would read true for a replay that produced a different plan.
  const chain = (order: readonly string[]): PlanningConstraints => ({
    ...BASE,
    items: [
      item('x', { effort: { kind: 'unknown' } }),
      item('y', { effort: { kind: 'unknown' } }),
      item('b', { dependsOn: order.map((id) => ({ dependsOnItemId: id, kind: 'temporal' as const })) }),
      item('c', { dependsOn: [{ dependsOnItemId: 'b', kind: 'temporal' }] }),
    ],
  });

  const forwards = chain(['x', 'y']);
  const backwards = chain(['y', 'x']);
  assert.equal(
    planningInputDigest(forwards, config()),
    planningInputDigest(backwards, config()),
    'the two requests must be the same request, or this test proves nothing',
  );
  assert.equal(
    planJson(forwards),
    planJson(backwards),
    'the transitive BLOCKED_BY_DEPENDENCY chain followed the order the edges were declared in',
  );
});

test('duplicate item ids are refused rather than double-booked', () => {
  // Two items sharing an id make `scheduled`, `unscheduled` and every diff
  // keyed by `itemId` ambiguous: the plan would carry two placements for one
  // id and `diffPlans` would silently keep whichever it saw last. There is no
  // reason code for it — well-formedness of the request is #29's job — so this
  // is a caller error, refused the same way an unusable slot grid is.
  assert.throws(
    () => schedulePlan({ ...BASE, items: [item('twin'), item('twin', { priority: 5 })] }, config()),
    /duplicate item id/,
  );
});

test('a tie on every ordering key but the last is broken by itemId, not by arrival', () => {
  // `alpha` and `beta` share a priority; only the id separates them. Presented
  // in either order they must come out the same way round.
  const tied = [item('t-b', { priority: 5 }), item('t-a', { priority: 5 })];
  const forwards = schedulePlan({ ...BASE, items: tied }, config());
  const backwards = schedulePlan({ ...BASE, items: tied.slice().reverse() }, config());

  assert.deepEqual(forwards.scheduled.map((entry) => entry.itemId), ['t-a', 't-b']);
  assert.deepEqual(JSON.stringify(forwards), JSON.stringify(backwards));
});

test('the unscheduled list and the constraint findings are ordered too', () => {
  const messy: PlanningConstraints = {
    ...BASE,
    workingWindows: [],
    items: [item('z', { effort: { kind: 'unknown' } }), item('a'), item('m')],
  };
  const forwards = schedulePlan(messy, config());
  const backwards = schedulePlan({ ...messy, items: messy.items.slice().reverse() }, config());

  assert.deepEqual(forwards.unscheduled.map((entry) => entry.itemId), ['a', 'm', 'z']);
  assert.equal(JSON.stringify(forwards), JSON.stringify(backwards));
});

test('changing the config changes the plan, and the plan says so through its digest', () => {
  const coarse = schedulePlan(BASE, config({ slotMinutes: 60 }));
  const fine = schedulePlan(BASE, config({ slotMinutes: 15 }));
  assert.notEqual(coarse.inputDigest, fine.inputDigest);
});

/* ── The digest ─────────────────────────────────────────────────── */

test('the digest is a hex sha256 and is stable across calls', () => {
  const digest = planningInputDigest(BASE, config());
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, planningInputDigest(BASE, config()));
  assert.equal(schedulePlan(BASE, config()).inputDigest, digest);
});

test('the canonical string carries no title, only a hash of one', () => {
  const secret = 'CONFIDENTIAL-USER-TEXT';
  const withTitle: PlanningConstraints = {
    ...BASE,
    items: [item('a', { title: secret })],
  };
  const canonical = canonicalPlanningInput(withTitle, config());

  assert.equal(
    canonical.includes(secret),
    false,
    'the canonical string is a value a caller may log; user text does not travel in it',
  );
  assert.notEqual(
    planningInputDigest(withTitle, config()),
    planningInputDigest({ ...withTitle, items: [item('a', { title: 'something else' })] }, config()),
    'and it must still be sensitive to the title, or a changed request would look unchanged',
  );
});

const MUTATIONS: readonly (readonly [string, PlanningConstraints])[] = [
  ['scopeId', { ...BASE, scopeId: 'other-scope' }],
  ['timezone', { ...BASE, timezone: 'Asia/Jerusalem' }],
  ['horizon start', { ...BASE, horizon: { ...BASE.horizon, startsAt: '2026-08-17T01:00:00.000Z' } }],
  ['horizon end', { ...BASE, horizon: { ...BASE.horizon, endsAt: '2026-08-19T00:00:00.000Z' } }],
  ['window id', { ...BASE, workingWindows: [{ ...WINDOWS[0], windowId: 'renamed' }, WINDOWS[1]] }],
  ['window weekday', { ...BASE, workingWindows: [{ ...WINDOWS[0], weekday: 2 }, WINDOWS[1]] }],
  ['window start', { ...BASE, workingWindows: [{ ...WINDOWS[0], startMinute: 541 }, WINDOWS[1]] }],
  ['window end', { ...BASE, workingWindows: [{ ...WINDOWS[0], endMinute: 781 }, WINDOWS[1]] }],
  ['window zone', { ...BASE, workingWindows: [{ ...WINDOWS[0], timezone: 'Asia/Jerusalem' }, WINDOWS[1]] }],
  ['window removed', { ...BASE, workingWindows: [WINDOWS[0]] }],
  ['window duplicated', { ...BASE, workingWindows: [...WINDOWS, WINDOWS[0]] }],
  ['event id', { ...BASE, fixedEvents: [{ ...EVENTS[0], eventId: 'renamed' }, EVENTS[1]] }],
  ['event blocking', { ...BASE, fixedEvents: [{ ...EVENTS[0], blocking: false }, EVENTS[1]] }],
  ['event source', { ...BASE, fixedEvents: [{ ...EVENTS[0], sourceCommitmentId: null }, EVENTS[1]] }],
  ['event interval', {
    ...BASE,
    fixedEvents: [
      { ...EVENTS[0], interval: { startsAt: '2026-08-17T10:00:00.000Z', endsAt: '2026-08-17T10:31:00.000Z' } },
      EVENTS[1],
    ],
  }],
  ['item id', { ...BASE, items: [{ ...ITEMS[0], itemId: 'renamed' }, ...ITEMS.slice(1)] }],
  ['item title', { ...BASE, items: [{ ...ITEMS[0], title: 'a different title' }, ...ITEMS.slice(1)] }],
  ['item effort minutes', {
    ...BASE,
    items: [{ ...ITEMS[0], effort: { kind: 'known', minutes: 61 } }, ...ITEMS.slice(1)],
  }],
  ['item effort kind', {
    ...BASE,
    items: [{ ...ITEMS[0], effort: { kind: 'unknown' } }, ...ITEMS.slice(1)],
  }],
  ['item earliest start', {
    ...BASE,
    items: [{ ...ITEMS[0], earliestStartAt: '2026-08-17T09:00:00.000Z' }, ...ITEMS.slice(1)],
  }],
  ['item deadline', {
    ...BASE,
    items: [{ ...ITEMS[0], deadlineAt: '2026-08-17T18:00:00.000Z' }, ...ITEMS.slice(1)],
  }],
  ['item priority', { ...BASE, items: [{ ...ITEMS[0], priority: 8 }, ...ITEMS.slice(1)] }],
  ['item buffer before', { ...BASE, items: [{ ...ITEMS[0], bufferBeforeMinutes: 5 }, ...ITEMS.slice(1)] }],
  ['item buffer after', { ...BASE, items: [{ ...ITEMS[0], bufferAfterMinutes: 16 }, ...ITEMS.slice(1)] }],
  ['dependency kind', {
    ...BASE,
    items: ITEMS.map((entry) => (entry.itemId === 'gamma'
      ? { ...entry, dependsOn: [{ dependsOnItemId: 'alpha', kind: 'resource' as const }, entry.dependsOn[1]] }
      : entry)),
  }],
  ['dependency target', {
    ...BASE,
    items: ITEMS.map((entry) => (entry.itemId === 'gamma'
      ? { ...entry, dependsOn: [{ dependsOnItemId: 'delta', kind: 'temporal' as const }, entry.dependsOn[1]] }
      : entry)),
  }],
  ['dependency removed', {
    ...BASE,
    items: ITEMS.map((entry) => (entry.itemId === 'gamma' ? { ...entry, dependsOn: [] } : entry)),
  }],
  ['item removed', { ...BASE, items: ITEMS.slice(1) }],
];

test('every meaningful change to the constraints changes the digest', () => {
  const baseline = planningInputDigest(BASE, config());
  const seen = new Map<string, string>([[baseline, 'the unmodified request']]);

  for (const [label, mutated] of MUTATIONS) {
    const digest = planningInputDigest(mutated, config());
    const collision = seen.get(digest);
    assert.equal(
      collision,
      undefined,
      `changing ${label} produced the same digest as ${collision ?? 'another case'}; two different `
        + 'requests that hash alike make sameInputDigest report a replay that never happened',
    );
    seen.set(digest, label);
  }
});

test('every field of the config changes the digest', () => {
  const baseline = planningInputDigest(BASE, config());
  for (const variant of [
    config({ slotMinutes: 30 }),
    config({ foldPolicy: 'latest' }),
    config({ resourceDependenciesOrder: true }),
  ]) {
    assert.notEqual(planningInputDigest(BASE, variant), baseline);
  }
});

test('the digest is versioned, so a change to the encoding cannot pass as a change to the input', () => {
  assert.match(canonicalPlanningInput(BASE, config()), /^\{"digestVersion":"plan-digest-v1"/);
});

test('non-finite numbers are encoded distinguishably rather than refused', () => {
  // This used to throw. The rule is that if the taxonomy names a bad value the
  // planner reports it, and throwing is reserved for input the taxonomy cannot
  // describe — and the digest is computed for *every* request, including the
  // ones whose findings are the whole answer, so it cannot be the thing that
  // refuses them.
  //
  // The original reason for refusing them still stands and is what is asserted
  // instead: `JSON.stringify(NaN)` is `"null"`, and so is
  // `JSON.stringify(null)`, so a naive encoding would hash a broken priority
  // and an absent one identically. Each non-finite value therefore has to be
  // distinguishable from the others and from null.
  const withPriority = (priority: number) => ({
    ...BASE,
    items: [{ ...ITEMS[0], priority }],
  });

  const digests = new Map<string, string>();
  for (const [label, priority] of [
    ['zero', 0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ] as const) {
    const digest = planningInputDigest(withPriority(priority), config());
    const collision = digests.get(digest);
    assert.equal(collision, undefined, `${label} hashes the same as ${collision ?? 'another value'}`);
    digests.set(digest, label);
  }

  // And a null-valued field must not collide with any of them either.
  const nullDeadline = planningInputDigest(BASE, config());
  assert.equal(digests.has(nullDeadline), false);
});

test('an unusable slot grid is refused rather than silently defaulted', () => {
  // A default grid would make two callers with different configs produce the
  // same plan while the digest recorded that their inputs differed.
  assert.throws(() => schedulePlan(BASE, config({ slotMinutes: 0 })), /slotMinutes/);
  assert.throws(() => schedulePlan(BASE, config({ slotMinutes: -15 })), /slotMinutes/);
});

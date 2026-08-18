/**
 * Behavioural tests for the canonical Life-State projection.
 *
 * Two properties dominate here and each has its own block below:
 *
 *  1. Determinism. Identical inputs must produce byte-identical output, so the
 *     assertions compare serialized JSON as well as structure — deepEqual alone
 *     ignores key order, which is exactly where nondeterminism hides.
 *
 *  2. Unknown is not empty. The empty-DomainState tests spell out, in their
 *     names, why each field lands on known-zero or on unknown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectLifeState } from '../../lib/lifeState/lifeStateProjection.ts';
import { bandForOpenCount } from '../../lib/lifeState/loadView.ts';
import { newestTimestamp } from '../../lib/lifeState/fields.ts';
import {
  DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS,
  LIFE_STATE_SCHEMA_VERSION,
  LOAD_BAND_THRESHOLDS,
  type LifeState,
} from '../../src/contracts/v1/lifeStateContracts.ts';
import {
  createEmptyDomainState,
  type Commitment,
  type DomainState,
  type Reminder,
} from '../../src/domain/stateMachine.ts';

const NOW = '2026-08-18T12:00:00.000Z';
const SCOPE = 'scope-1';

function commitment(overrides: Partial<Commitment> & { id: string }): Commitment {
  return {
    kind: 'task',
    title: `title ${overrides.id}`,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
    ...overrides,
  };
}

function stateOf(commitments: readonly Commitment[], reminders: readonly Reminder[] = []): DomainState {
  const state = createEmptyDomainState();
  for (const item of commitments) state.commitments[item.id] = item;
  for (const reminder of reminders) state.reminders[reminder.id] = reminder;
  return state;
}

function project(state: DomainState, windowDays?: number): LifeState {
  return projectLifeState({ state, now: NOW, scopeId: SCOPE, windowDays });
}

/* ── Determinism and replayability ───────────────────────────────── */

test('the same input projected twice yields byte-identical output including inputDigest', () => {
  const state = stateOf([
    commitment({ id: 'c_b', status: 'completed', completedAt: '2026-08-14T09:00:00.000Z', updatedAt: '2026-08-14T09:00:00.000Z', currentAckState: 'completed' }),
    commitment({ id: 'c_a', timeSpec: { kind: 'due_by', dueAt: '2026-08-17T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
  ]);

  const first = project(state);
  const second = project(state);

  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(first.inputDigest, second.inputDigest);
});

test('reordering keys in the input state changes neither the digest nor the serialized output', () => {
  const overdue = commitment({
    id: 'c_a',
    timeSpec: { kind: 'due_by', dueAt: '2026-08-17T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    updatedAt: '2026-08-16T00:00:00.000Z',
  });
  const done = commitment({
    id: 'c_b',
    status: 'completed',
    currentAckState: 'completed',
    completedAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:00:00.000Z',
  });

  // Different insertion order, and a different status encountered first, which
  // is what would reorder the keys of countsByStatus in a naive implementation.
  const forward: DomainState = { commitments: { c_a: overdue, c_b: done }, reminders: {}, escalationStates: {} };
  const reversed: DomainState = { escalationStates: {}, commitments: { c_b: done, c_a: overdue }, reminders: {} };

  const a = project(forward);
  const b = project(reversed);

  assert.equal(a.inputDigest, b.inputDigest);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('projection survives arbitrary reshuffling of every record map and nested object', () => {
  // A seeded LCG rather than Math.random: a determinism test that is itself
  // nondeterministic can only produce unreproducible failures.
  let seed = 20260818;
  const nextRandom = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const reshuffle = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(reshuffle);
    if (value === null || typeof value !== 'object') return value;

    const keys = Object.keys(value as Record<string, unknown>);
    for (let index = keys.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(nextRandom() * (index + 1));
      [keys[index], keys[swap]] = [keys[swap], keys[index]];
    }
    const rebuilt: Record<string, unknown> = {};
    for (const key of keys) rebuilt[key] = reshuffle((value as Record<string, unknown>)[key]);
    return rebuilt;
  };

  const state = stateOf(
    [
      commitment({ id: 'c_3', status: 'draft' }),
      commitment({ id: 'c_1', timeSpec: { kind: 'due_by', dueAt: '2026-08-17T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
      commitment({ id: 'c_10', status: 'deferred', currentAckState: 'postponed', postponedUntil: '2026-08-19T09:00:00.000Z', updatedAt: '2026-08-17T09:00:00.000Z' }),
      commitment({ id: 'c_2', status: 'completed', currentAckState: 'completed', completedAt: '2026-08-13T09:00:00.000Z', updatedAt: '2026-08-13T09:00:00.000Z' }),
      commitment({ id: 'c_4', status: 'dropped', currentAckState: 'completed', droppedAt: '2026-08-12T09:00:00.000Z', updatedAt: '2026-08-12T09:00:00.000Z' }),
      commitment({ id: 'c_5', currentAckState: 'ignored', updatedAt: '2026-08-16T09:00:00.000Z', timeSpec: { kind: 'scheduled_event', dueAt: '2026-08-19T14:00:00.000Z', remindAt: null, timezone: 'Asia/Jerusalem' } }),
    ],
    [
      { id: 'r_2', commitmentId: 'c_1', reminderType: 'due_soon', scheduledFor: '2026-08-17T08:00:00.000Z', status: 'snoozed', requiresAction: true, deliveredAt: null, acknowledgedAt: null, snoozedUntil: '2026-08-18T08:00:00.000Z', createdAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-08-16T09:00:00.000Z' },
      { id: 'r_1', commitmentId: 'c_5', reminderType: 'check_in', scheduledFor: '2026-08-16T08:00:00.000Z', status: 'ignored', requiresAction: true, deliveredAt: '2026-08-16T08:00:00.000Z', acknowledgedAt: null, snoozedUntil: null, createdAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-08-16T09:00:00.000Z' },
    ]
  );

  const expected = JSON.stringify(project(state));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const shuffled = reshuffle(state) as DomainState;
    assert.equal(JSON.stringify(project(shuffled)), expected, `reshuffle attempt ${attempt} changed the projection`);
  }
});

test('computedAt is taken from input.now rather than the system clock', () => {
  const projection = project(createEmptyDomainState());

  assert.equal(projection.computedAt, NOW);
  assert.equal(projection.commitments.provenance.computedAt, NOW);
  assert.equal(projection.availability.provenance.computedAt, NOW);
  assert.equal(projection.load.provenance.computedAt, NOW);
  assert.equal(projection.recentOutcomes.provenance.computedAt, NOW);
});

test('projection carries the contract schema version and the caller scope', () => {
  const projection = project(createEmptyDomainState());

  assert.equal(projection.version, LIFE_STATE_SCHEMA_VERSION);
  assert.equal(projection.scopeId, SCOPE);
});

test('projection rejects an unparseable now, because a replay could not reproduce it', () => {
  assert.throws(
    () => projectLifeState({ state: createEmptyDomainState(), now: 'yesterday', scopeId: SCOPE }),
    /now must be a valid ISO timestamp/
  );
});

test('projection rejects a blank scopeId, because an unscoped life state cannot be attributed', () => {
  assert.throws(
    () => projectLifeState({ state: createEmptyDomainState(), now: NOW, scopeId: '   ' }),
    /scopeId must be a non-empty string/
  );
});

test('projection does not mutate the DomainState it reads', () => {
  const state = stateOf([commitment({ id: 'c_a' })]);
  const before = JSON.stringify(state);
  project(state);
  assert.equal(JSON.stringify(state), before);
});

/* ── Unknown is distinct from zero and from empty ────────────────── */

test('empty DomainState: commitments is known-zero, because the commitment set is canonically ours and empty is a fact', () => {
  const { commitments } = project(createEmptyDomainState());

  assert.equal(commitments.known, true);
  if (!commitments.known) return;
  assert.deepEqual(commitments.value, {
    countsByStatus: {},
    openCount: 0,
    overdueCount: 0,
    openCommitmentIds: [],
    overdueCommitmentIds: [],
  });
  assert.equal('reason' in commitments, false);
});

test('empty DomainState: load is known-zero and light, because load is a total function over the open set', () => {
  const { load } = project(createEmptyDomainState());

  assert.equal(load.known, true);
  if (!load.known) return;
  assert.deepEqual(load.value, {
    totalUrgencyScore: 0,
    openCount: 0,
    overdueCount: 0,
    dueSoonCount: 0,
    band: 'light',
  });
});

test('empty DomainState: availability is unknown NO_DATA, because an empty busy list would read as "free" and there is no calendar source', () => {
  const { availability } = project(createEmptyDomainState());

  assert.equal(availability.known, false);
  if (availability.known) return;
  assert.equal(availability.reason, 'NO_DATA');
  assert.equal('value' in availability, false);
  assert.equal(availability.provenance.source, 'absent');
  assert.equal(availability.provenance.derivedFrom, null);
});

test('empty DomainState: recentOutcomes is unknown NO_DATA, because zero outcomes over zero commitments is not behavioural evidence', () => {
  const { recentOutcomes } = project(createEmptyDomainState());

  assert.equal(recentOutcomes.known, false);
  if (recentOutcomes.known) return;
  assert.equal(recentOutcomes.reason, 'NO_DATA');
  assert.equal(recentOutcomes.provenance.source, 'absent');
});

test('commitments exist but none is timed: availability is unknown INSUFFICIENT_DATA, not NO_DATA', () => {
  const { availability } = project(stateOf([commitment({ id: 'c_a' }), commitment({ id: 'c_b' })]));

  assert.equal(availability.known, false);
  if (availability.known) return;
  assert.equal(availability.reason, 'INSUFFICIENT_DATA');
  // Records were read and found unhelpful, so provenance still points at them.
  assert.equal(availability.provenance.source, 'domain_state');
  assert.equal(availability.provenance.derivedFrom, '2026-08-01T00:00:00.000Z');
});

test('commitments exist with no outcome inside the window: recentOutcomes is known-zero, because "nothing finished in 14 days" is a real signal', () => {
  const { recentOutcomes } = project(stateOf([
    commitment({ id: 'c_a', status: 'completed', currentAckState: 'completed', completedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }),
  ]));

  assert.equal(recentOutcomes.known, true);
  if (!recentOutcomes.known) return;
  assert.equal(recentOutcomes.value.completedCount, 0);
  assert.equal(recentOutcomes.value.droppedCount, 0);
  assert.deepEqual(recentOutcomes.value.countsByAckState, {});
  // The state was read and searched; nothing inside the window contributed a
  // timestamp. That is "looked and found nothing", which is not the same as
  // "never looked" — so source stays domain_state while derivedFrom is null.
  assert.equal(recentOutcomes.provenance.source, 'domain_state');
  assert.equal(recentOutcomes.provenance.derivedFrom, null);
});

test('source and derivedFrom are independent: absent means nothing was read, not merely that nothing carried a timestamp', () => {
  // Empty state: nothing to read at all.
  const empty = project(createEmptyDomainState());
  assert.equal(empty.recentOutcomes.provenance.source, 'absent');
  assert.equal(empty.recentOutcomes.provenance.derivedFrom, null);

  // Populated state, but no outcome inside the window: read, found nothing.
  const populated = project(stateOf([
    commitment({ id: 'c_a', status: 'completed', currentAckState: 'completed', completedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }),
  ]));
  assert.equal(populated.recentOutcomes.provenance.source, 'domain_state');
  assert.equal(populated.recentOutcomes.provenance.derivedFrom, null);

  // Both report derivedFrom null, so source is the only thing that tells a
  // consumer these two situations apart.
});

/* ── CommitmentsView ─────────────────────────────────────────────── */

test('commitments view counts every status, and open/overdue sets are id-sorted', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_z', timeSpec: { kind: 'due_by', dueAt: '2026-08-17T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_a', timeSpec: { kind: 'due_by', dueAt: '2026-08-10T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_m', status: 'draft' }),
    commitment({ id: 'c_done', status: 'completed', currentAckState: 'completed', completedAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-08-15T09:00:00.000Z' }),
    commitment({ id: 'c_missed', status: 'missed', updatedAt: '2026-08-15T09:00:00.000Z' }),
  ]));

  assert.equal(projection.commitments.known, true);
  if (!projection.commitments.known) return;
  const view = projection.commitments.value;

  assert.deepEqual(view.countsByStatus, { draft: 1, active: 2, completed: 1, missed: 1 });
  // c_missed counts as open: the state machine still accepts Complete/Postpone
  // on it, so it is live work, not a finished outcome.
  assert.equal(view.openCount, 4);
  assert.deepEqual(view.openCommitmentIds, ['c_a', 'c_m', 'c_missed', 'c_z']);
  // It carries no dueAt, so being open does not make it overdue.
  assert.deepEqual(view.overdueCommitmentIds, ['c_a', 'c_z']);
  assert.equal(view.overdueCount, 2);
  assert.equal(projection.commitments.provenance.derivedFrom, '2026-08-15T09:00:00.000Z');
  assert.equal(projection.commitments.provenance.source, 'domain_state');
});

test('a missed commitment is open work, not a finished outcome, so it raises load rather than counting as an outcome', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_missed', status: 'missed', updatedAt: '2026-08-15T09:00:00.000Z' }),
  ]));

  assert.equal(projection.commitments.known, true);
  assert.equal(projection.load.known, true);
  if (!projection.commitments.known || !projection.load.known) return;

  // Open, and therefore contributing to load.
  assert.equal(projection.commitments.value.openCount, 1);
  assert.deepEqual(projection.commitments.value.openCommitmentIds, ['c_missed']);
  assert.equal(projection.load.value.openCount, 1);

  // Missing a deadline is a behavioural signal, but the work is not finished,
  // so it must not be reported as a completed outcome.
  assert.equal(projection.recentOutcomes.known, true);
  if (!projection.recentOutcomes.known) return;
  assert.equal(projection.recentOutcomes.value.completedCount, 0);
  assert.equal(projection.recentOutcomes.value.droppedCount, 0);
});

test('countsByStatus emits keys in lifecycle order, not in whatever order commitments were encountered', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_a', status: 'completed', currentAckState: 'completed', completedAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-08-15T09:00:00.000Z' }),
    commitment({ id: 'c_b', status: 'draft' }),
  ]));

  assert.equal(projection.commitments.known, true);
  if (!projection.commitments.known) return;
  // Encounter order (ids ascending) would have produced ['completed', 'draft'].
  assert.deepEqual(Object.keys(projection.commitments.value.countsByStatus), ['draft', 'completed']);
});

test('a terminal commitment past its due date is not overdue, because overdue only applies to open work', () => {
  const projection = project(stateOf([
    commitment({
      id: 'c_done',
      status: 'completed',
      currentAckState: 'completed',
      completedAt: '2026-08-15T09:00:00.000Z',
      updatedAt: '2026-08-15T09:00:00.000Z',
      timeSpec: { kind: 'due_by', dueAt: '2026-08-10T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
  ]));

  assert.equal(projection.commitments.known, true);
  if (!projection.commitments.known) return;
  assert.equal(projection.commitments.value.overdueCount, 0);
  assert.equal(projection.commitments.value.openCount, 0);
});

/* ── AvailabilityView ────────────────────────────────────────────── */

test('busy windows come from open timed commitments only, sorted by start time rather than by id', () => {
  // Ids are deliberately in the opposite order to the due dates, so an
  // implementation that leaned on the id ordering would fail here.
  const projection = project(stateOf([
    commitment({ id: 'c_a', timeSpec: { kind: 'scheduled_event', dueAt: '2026-08-20T15:00:00.000Z', remindAt: null, timezone: 'Asia/Jerusalem' } }),
    commitment({ id: 'c_b', timeSpec: { kind: 'due_by', dueAt: '2026-08-19T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_c_open_untimed' }),
    commitment({
      id: 'c_d_done',
      status: 'completed',
      currentAckState: 'completed',
      completedAt: '2026-08-15T09:00:00.000Z',
      updatedAt: '2026-08-15T09:00:00.000Z',
      timeSpec: { kind: 'due_by', dueAt: '2026-08-25T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    }),
  ]));

  assert.equal(projection.availability.known, true);
  if (!projection.availability.known) return;
  const view = projection.availability.value;

  assert.deepEqual(view.busyWindows, [
    { commitmentId: 'c_b', startsAt: '2026-08-19T09:00:00.000Z', endsAt: null, timezone: 'UTC', kind: 'due_by' },
    { commitmentId: 'c_a', startsAt: '2026-08-20T15:00:00.000Z', endsAt: null, timezone: 'Asia/Jerusalem', kind: 'scheduled_event' },
  ]);
  assert.equal(view.unscheduledCommitmentCount, 1);
});

test('a commitment carrying a dueAt under an unscheduled timeSpec still constrains time as a due_by window', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_a', timeSpec: { kind: 'unscheduled', dueAt: '2026-08-19T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
  ]));

  assert.equal(projection.availability.known, true);
  if (!projection.availability.known) return;
  assert.equal(projection.availability.value.busyWindows.length, 1);
  assert.equal(projection.availability.value.busyWindows[0].kind, 'due_by');
});

test('a reminder time alone is not a busy window, because a nudge is delivery machinery not an appointment', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_a', timeSpec: { kind: 'scheduled_event', dueAt: null, remindAt: '2026-08-19T09:00:00.000Z', timezone: 'UTC' } }),
  ]));

  assert.equal(projection.availability.known, false);
  if (projection.availability.known) return;
  assert.equal(projection.availability.reason, 'INSUFFICIENT_DATA');
});

/* ── LoadView ────────────────────────────────────────────────────── */

test('load bands follow the exported thresholds on open commitment count', () => {
  assert.equal(bandForOpenCount(0), 'light');
  assert.equal(bandForOpenCount(LOAD_BAND_THRESHOLDS.light), 'light');
  assert.equal(bandForOpenCount(LOAD_BAND_THRESHOLDS.light + 1), 'moderate');
  assert.equal(bandForOpenCount(LOAD_BAND_THRESHOLDS.moderate), 'moderate');
  assert.equal(bandForOpenCount(LOAD_BAND_THRESHOLDS.moderate + 1), 'heavy');
  assert.equal(bandForOpenCount(LOAD_BAND_THRESHOLDS.heavy), 'heavy');
  assert.equal(bandForOpenCount(LOAD_BAND_THRESHOLDS.heavy + 1), 'overloaded');
});

test('load sums agenda urgency over open commitments and counts overdue and due-soon work', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_overdue', timeSpec: { kind: 'due_by', dueAt: '2026-08-17T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_due_soon', timeSpec: { kind: 'due_by', dueAt: '2026-08-18T20:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_far', timeSpec: { kind: 'due_by', dueAt: '2026-09-30T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_done', status: 'completed', currentAckState: 'completed', completedAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-08-15T09:00:00.000Z' }),
  ]));

  assert.equal(projection.load.known, true);
  if (!projection.load.known) return;
  const view = projection.load.value;

  assert.equal(view.openCount, 3);
  assert.equal(view.overdueCount, 1);
  assert.equal(view.dueSoonCount, 1);
  assert.equal(view.band, 'moderate');
  assert.equal(Number.isInteger(view.totalUrgencyScore), true);
  // The overdue item alone sits in the 7000-band of the agenda scorer.
  assert.ok(view.totalUrgencyScore >= 7000, `expected an overdue-band total, got ${view.totalUrgencyScore}`);
});

test('load total is order-independent, so an integer sum cannot drift with insertion order', () => {
  const items = [
    commitment({ id: 'c_1', timeSpec: { kind: 'due_by', dueAt: '2026-08-17T09:00:00.000Z', remindAt: null, timezone: 'UTC' }, priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'firm' } }),
    commitment({ id: 'c_2', timeSpec: { kind: 'due_by', dueAt: '2026-08-18T18:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
    commitment({ id: 'c_3', status: 'deferred', currentAckState: 'postponed', postponedUntil: '2026-08-19T09:00:00.000Z' }),
  ];
  const forward = project(stateOf(items));
  const reversed = project(stateOf([...items].reverse()));

  assert.equal(JSON.stringify(forward.load), JSON.stringify(reversed.load));
});

/* ── RecentOutcomesView ──────────────────────────────────────────── */

test('recent outcomes count status terminals and terminal ack states inside the window', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_done_in', status: 'completed', currentAckState: 'completed', completedAt: '2026-08-15T10:00:00.000Z', updatedAt: '2026-08-15T10:00:00.000Z' }),
    commitment({ id: 'c_done_old', status: 'completed', currentAckState: 'completed', completedAt: '2026-07-01T10:00:00.000Z', updatedAt: '2026-07-01T10:00:00.000Z' }),
    commitment({ id: 'c_dropped_in', status: 'dropped', currentAckState: 'completed', droppedAt: '2026-08-16T10:00:00.000Z', updatedAt: '2026-08-16T10:00:00.000Z' }),
    commitment({ id: 'c_postponed', currentAckState: 'postponed', postponedUntil: '2026-08-19T10:00:00.000Z', updatedAt: '2026-08-17T10:00:00.000Z' }),
    commitment({ id: 'c_ignored', currentAckState: 'ignored', updatedAt: '2026-08-17T11:00:00.000Z' }),
    commitment({ id: 'c_seen', currentAckState: 'seen', updatedAt: '2026-08-17T12:00:00.000Z' }),
  ]));

  assert.equal(projection.recentOutcomes.known, true);
  if (!projection.recentOutcomes.known) return;
  const view = projection.recentOutcomes.value;

  assert.equal(view.windowDays, DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
  assert.equal(view.windowStart, '2026-08-04T12:00:00.000Z');
  assert.equal(view.completedCount, 1);
  assert.equal(view.droppedCount, 1);
  assert.equal(view.postponedCount, 1);
  assert.equal(view.ignoredCount, 1);
  // A dropped commitment carries ack state 'completed' per the state machine, so
  // the ack tally and the status tally disagree on purpose.
  assert.deepEqual(view.countsByAckState, { postponed: 1, completed: 2, ignored: 1 });
  // Encounter order would have produced ['completed', 'ignored', 'postponed'].
  assert.deepEqual(Object.keys(view.countsByAckState), ['postponed', 'completed', 'ignored']);
  assert.equal(projection.recentOutcomes.provenance.derivedFrom, '2026-08-17T11:00:00.000Z');
});

test('a shorter window excludes outcomes that a longer window would include', () => {
  const state = stateOf([
    commitment({ id: 'c_done', status: 'completed', currentAckState: 'completed', completedAt: '2026-08-10T10:00:00.000Z', updatedAt: '2026-08-10T10:00:00.000Z' }),
  ]);

  const wide = project(state, 14);
  const narrow = project(state, 3);

  assert.equal(wide.recentOutcomes.known && wide.recentOutcomes.value.completedCount, 1);
  assert.equal(narrow.recentOutcomes.known && narrow.recentOutcomes.value.completedCount, 0);
  assert.equal(narrow.recentOutcomes.known && narrow.recentOutcomes.value.windowDays, 3);
});

test('an outcome timestamped after now is excluded, so a clock-skewed record cannot inflate the window', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_future', status: 'completed', currentAckState: 'completed', completedAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' }),
  ]));

  assert.equal(projection.recentOutcomes.known, true);
  if (!projection.recentOutcomes.known) return;
  assert.equal(projection.recentOutcomes.value.completedCount, 0);
});

/* ── Provenance helpers ──────────────────────────────────────────── */

test('newestTimestamp picks the latest instant and breaks ties without depending on argument order', () => {
  assert.equal(newestTimestamp([]), null);
  assert.equal(newestTimestamp([null, undefined]), null);
  assert.equal(newestTimestamp(['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']), '2026-02-01T00:00:00.000Z');
  assert.equal(newestTimestamp(['2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']), '2026-02-01T00:00:00.000Z');
  assert.equal(newestTimestamp(['not-a-date', '2026-01-01T00:00:00.000Z']), '2026-01-01T00:00:00.000Z');

  // Same instant spelled two ways: the winner must not depend on which came first.
  const spellings = ['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00Z'];
  assert.equal(newestTimestamp(spellings), newestTimestamp([...spellings].reverse()));
});

test('every field carries source, derivedFrom and computedAt', () => {
  const projection = project(stateOf([
    commitment({ id: 'c_a', timeSpec: { kind: 'due_by', dueAt: '2026-08-19T09:00:00.000Z', remindAt: null, timezone: 'UTC' } }),
  ]));

  for (const field of [projection.commitments, projection.availability, projection.load, projection.recentOutcomes]) {
    assert.ok(['domain_state', 'deterministic_rule', 'absent'].includes(field.provenance.source));
    assert.equal(field.provenance.computedAt, NOW);
    assert.equal(field.provenance.derivedFrom === null || typeof field.provenance.derivedFrom === 'string', true);
  }
});

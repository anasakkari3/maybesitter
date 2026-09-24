/**
 * The allowlist, asserted against the domain rather than against itself
 * (UC-3.15, #201).
 *
 * A test that only checked "`commitment_completed` becomes `completed`" would
 * pass forever while the thing #201 actually forbids happened: a domain event
 * added next sprint — a pressure delivery, a classification change, a safety
 * decision — quietly appearing in somebody's activity history. So the first
 * test reads the event types `src/domain/stateMachine.ts` really emits and
 * requires each one to be *either* mapped to a kind *or* named below as
 * deliberately not user-facing. Adding an emit without deciding which it is
 * fails here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ACTIVITY_KIND_BY_EVENT_TYPE,
  PRODUCED_ACTIVITY_KINDS,
  projectActivity,
  type ActivityKind,
} from '../../lib/services/activity/activityProjection.ts';
import type { DomainEventRecord } from '../../lib/services/mobile/eventLog.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Domain events that exist and must never reach the activity screen, each with
 * the reason it is excluded. This is a decision record, not a denylist: the
 * projection ignores everything it does not map, and this list is how the test
 * can tell "deliberately excluded" from "forgotten".
 */
const NOT_USER_FACING: Readonly<Record<string, string>> = {
  // «لسّا» on a commitment. #200's `reminder_acknowledged` is the tap on a
  // soft reminder and is a different event; conflating them would put a count
  // under the wrong label and make #200 a breaking change.
  commitment_aware: 'awareness of a commitment is not the reminder acknowledgement #200 adds',
  // The system re-ranking someone's item. A record of the product's own
  // judgement about their priorities, not of anything they did.
  commitment_deprioritized: 'a ranking decision the system made, not an action the user took',
  // Fires on any field edit, including ones the user never sees.
  commitment_updated: 'an edit is not an outcome, and it fires for internal field changes too',
  reminder_delivered: 'something the product did to the user',
  reminder_ignored: 'a judgement about a non-response — exactly the shape #201 forbids',
  escalation_delivered: 'pressure delivery; #201 names it as never user-visible',
};

/** Every `makeEvent('…')` the state machine can produce. */
function emittedEventTypes(): string[] {
  const source = readFileSync(join(repoRoot, 'src/domain/stateMachine.ts'), 'utf8');
  const found = new Set<string>();
  for (const match of Array.from(source.matchAll(/makeEvent\(\s*'([a-z_]+)'/g))) found.add(match[1]!);
  return Array.from(found).sort();
}

function record(over: Partial<DomainEventRecord> & { type: string }): DomainEventRecord {
  return {
    id: over.id ?? `e-${over.type}`,
    type: over.type,
    at: over.at ?? '2026-09-14T09:00:00.000Z',
    aggregateId: over.aggregateId ?? 'c1',
    payload: over.payload ?? {},
  };
}

const TITLES = new Map([['c1', { title: 'Call the clinic' }]]);

test('every domain event the state machine emits is either mapped or declared not user-facing', () => {
  const emitted = emittedEventTypes();
  assert.ok(emitted.length >= 11, `parsed only ${emitted.length} event types; this check would be vacuous`);

  const undecided = emitted.filter((type) =>
    ACTIVITY_KIND_BY_EVENT_TYPE[type] === undefined && NOT_USER_FACING[type] === undefined);
  assert.deepEqual(
    undecided,
    [],
    'a new domain event is neither mapped to an ActivityKind nor declared not user-facing — decide, do not let it leak',
  );

  const both = emitted.filter((type) =>
    ACTIVITY_KIND_BY_EVENT_TYPE[type] !== undefined && NOT_USER_FACING[type] !== undefined);
  assert.deepEqual(both, [], 'an event type cannot be both allowed and excluded');
});

test('the declared exclusions are all real event types, so the list cannot rot', () => {
  const emitted = new Set(emittedEventTypes());
  const stale = Object.keys(NOT_USER_FACING).filter((type) => !emitted.has(type));
  assert.deepEqual(stale, [], 'these exclusions name events the state machine no longer emits');
});

test('pressure, classification and analytics events never become activity', () => {
  // Shaped like the events other tracks write, including ones that do not
  // exist yet: an unmapped type produces nothing, whatever it is called.
  const hostile = [
    'escalation_delivered', 'reminder_delivered', 'reminder_ignored',
    'commitment_deprioritized', 'commitment_updated', 'commitment_aware',
    'pressure_delivered', 'classification_changed', 'analytics_event_recorded',
    'safety_gate_blocked', 'memory_fact_inferred',
  ].map((type) => record({ type }));

  assert.deepEqual(projectActivity(hostile, TITLES), []);
});

test('the eight kinds with a producer today are projected from their events', () => {
  const items = projectActivity([
    record({ type: 'draft_created', id: 'e1', at: '2026-09-14T08:00:00.000Z' }),
    record({ type: 'commitment_activated', id: 'e2', at: '2026-09-14T08:01:00.000Z' }),
    record({ type: 'commitment_completed', id: 'e3', at: '2026-09-14T08:02:00.000Z' }),
    record({
      type: 'commitment_postponed', id: 'e4', at: '2026-09-14T08:03:00.000Z',
      payload: { postponedUntil: '2026-09-15T08:00:00.000Z' },
    }),
    record({ type: 'commitment_dropped', id: 'e5', at: '2026-09-14T08:04:00.000Z' }),
    // Read from the plan ledger (#194) and shaped by planActivity: a day, not
    // a commitment, so no aggregate.
    record({ type: 'plan_accepted', id: 'e6', at: '2026-09-14T08:05:00.000Z', aggregateId: '', payload: { planDate: '2026-09-14' } }),
    // Also from the plan ledger (#587): a proposed change the person accepted.
    record({ type: 'plan_proposal_accepted', id: 'e8', at: '2026-09-14T08:05:30.000Z', aggregateId: '', payload: { planDate: '2026-09-14' } }),
    // A tap on a reminder notification (#200).
    record({ type: 'reminder_acknowledged', id: 'e7', at: '2026-09-14T08:06:00.000Z', payload: { commitmentId: 'c1' } }),
  ], TITLES);

  assert.deepEqual(items.map((item) => item.kind), [...PRODUCED_ACTIVITY_KINDS]);
  assert.deepEqual(items.slice(0, 5).map((item) => item.commitmentTitle), Array(5).fill('Call the clinic'));
  assert.equal(items[3]!.detail?.postponedUntil, '2026-09-15T08:00:00.000Z');
  assert.equal(items[0]!.detail, undefined);
  assert.deepEqual(
    [items[5]!.commitmentId, items[5]!.commitmentTitle, items[5]!.detail],
    [null, null, { planDate: '2026-09-14' }],
  );
  // An accepted change is about a day too, and says which one.
  assert.deepEqual(
    [items[6]!.commitmentId, items[6]!.commitmentTitle, items[6]!.detail],
    [null, null, { planDate: '2026-09-14' }],
  );
});

test('a plan date that is not a calendar date is dropped rather than passed on', () => {
  const [item] = projectActivity([
    record({ type: 'plan_accepted', id: 'e6', aggregateId: '', payload: { planDate: 'tomorrow' } }),
  ], TITLES);
  assert.equal(item!.detail, undefined);
});

test('a reminder acknowledgement names its commitment from the payload', () => {
  // `MarkAware` with `source: 'reminder'` produces it (#200);
  // tests/mobile/commitmentActionsIdempotency.test.ts drives the real route.
  const items = projectActivity([
    record({ type: 'reminder_acknowledged', id: 'e7', aggregateId: 'r-1', payload: { commitmentId: 'c1' } }),
  ], TITLES);

  assert.deepEqual(items.map((item) => item.kind), ['reminder_acknowledged']);
  // The reminder event is stamped with the reminder, so the commitment has to
  // come out of the payload or the entry would name an id nothing has.
  assert.equal(items[0]!.commitmentId, 'c1');
  assert.equal(items[0]!.commitmentTitle, 'Call the clinic');
});

test('a deleted commitment leaves the title null rather than inventing one', () => {
  const items = projectActivity([record({ type: 'commitment_completed', aggregateId: 'gone' })], TITLES);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.commitmentId, 'gone');
  assert.equal(items[0]!.commitmentTitle, null);
});

test('a renamed commitment reads as its current name', () => {
  const renamed = new Map([['c1', { title: 'Call the clinic back' }]]);
  const items = projectActivity([record({ type: 'commitment_completed' })], renamed);
  assert.equal(items[0]!.commitmentTitle, 'Call the clinic back');
});

test('every mapped kind is one the ActivityKind union names', () => {
  const kinds: ActivityKind[] = [
    'captured', 'confirmed', 'completed', 'postponed', 'dropped', 'plan_accepted', 'plan_proposal_accepted',
    'reminder_acknowledged',
  ];
  assert.deepEqual(Array.from(new Set(Object.values(ACTIVITY_KIND_BY_EVENT_TYPE))).sort(), [...kinds].sort());
});

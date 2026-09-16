/**
 * The fourth piece of the owner's own request: not just knowing about the
 * match, not just keeping work off it, not just putting it on the calendar,
 * but telling him when something else lands on top of it (#football-fixtures
 * task 10). `findCollisions` warns; it never refuses, because the user is
 * allowed to book over Saturday's match -- they are just not allowed to do it
 * without being told.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCollisions } from '../../lib/services/timeCollision.ts';
import { normalizeStoredTimeSpec, type Commitment } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';

// Copied from tests/dailyPlan/fixedEventDuration.test.ts rather than imported:
// a test helper is not a production interface, and two test files sharing one
// would couple their unrelated failures together.
function commitmentAt(id: string, dueAt: string, endAt: string | null): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: normalizeStoredTimeSpec({ kind: 'scheduled_event', dueAt, endAt, timezone: TZ }),
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: dueAt,
    updatedAt: dueAt,
    confirmedAt: dueAt,
    completedAt: null,
    droppedAt: null,
  };
}

const MATCH = commitmentAt('match', '2026-10-25T19:00:00.000Z', '2026-10-25T21:00:00.000Z');

test('a commitment inside a match collides', () => {
  const found = findCollisions({ dueAt: '2026-10-25T20:00:00.000Z', endAt: null }, [MATCH]);
  assert.equal(found.length, 1);
  assert.equal(found[0].commitmentId, 'match');
});

test('a commitment that ends exactly when the match starts does not collide', () => {
  // Half-open intervals: back-to-back is not a clash. Warning here would train
  // people to ignore the warning.
  const found = findCollisions({ dueAt: '2026-10-25T18:00:00.000Z', endAt: '2026-10-25T19:00:00.000Z' }, [MATCH]);
  assert.deepEqual(found, []);
});

test('a commitment that starts exactly when the match ends does not collide', () => {
  const found = findCollisions({ dueAt: '2026-10-25T21:00:00.000Z', endAt: null }, [MATCH]);
  assert.deepEqual(found, []);
});

test('a candidate with no end is measured at the default length', () => {
  // 20:45 + 30 minutes crosses 21:00, so it overlaps; 21:00 + 30 does not.
  assert.equal(findCollisions({ dueAt: '2026-10-25T20:45:00.000Z', endAt: null }, [MATCH]).length, 1);
});

test('an unscheduled commitment cannot be collided with', () => {
  const floating = commitmentAt('todo', '2026-10-25T19:00:00.000Z', null);
  floating.timeSpec = { ...floating.timeSpec, kind: 'due_by' };
  assert.deepEqual(findCollisions({ dueAt: '2026-10-25T19:30:00.000Z', endAt: null }, [floating]), []);
});

test('a dropped commitment cannot be collided with', () => {
  const dropped = commitmentAt('gone', '2026-10-25T19:00:00.000Z', '2026-10-25T21:00:00.000Z');
  dropped.status = 'dropped';
  assert.deepEqual(findCollisions({ dueAt: '2026-10-25T20:00:00.000Z', endAt: null }, [dropped]), []);
});

test('the warning names what was collided with', () => {
  // "This clashes with something" is not usable. The user needs to know it is
  // the match, so they can decide which of the two they actually meant.
  const [warning] = findCollisions({ dueAt: '2026-10-25T20:00:00.000Z', endAt: null }, [MATCH]);
  assert.equal(warning.title, 'match');
  assert.equal(warning.startsAt, '2026-10-25T19:00:00.000Z');
  assert.equal(warning.endsAt, '2026-10-25T21:00:00.000Z');
});

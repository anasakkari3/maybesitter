/**
 * Ranking through the list routes (UC-2.8, #169).
 *
 * ── The equivalence test is the safety net ───────────────────────
 *
 * With `MAYBESITTER_FEATURE_PRIORITY=false` the lists must be byte-identical
 * to what they were before this feature existed. That is what makes the flag a
 * real switch rather than a hope: if ranking is wrong in production, turning
 * it off restores a known-good order without a deploy.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { Commitment, Priority } from '../../src/domain/stateMachine.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';

const BASE = 'http://127.0.0.1:4321';
const REFERENCE = '2026-09-13T09:00:00.000Z';
const UID = uidFor('RankingUser');

let auth: FakeAuthControls | null = null;
let previousFlag: string | undefined;

function begin(flag: string): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  previousFlag = process.env.MAYBESITTER_FEATURE_PRIORITY;
  process.env.MAYBESITTER_FEATURE_PRIORITY = flag;
}

function end(): void {
  if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_PRIORITY;
  else process.env.MAYBESITTER_FEATURE_PRIORITY = previousFlag;
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function priority(level: Priority['level'], source: Priority['source']): Priority {
  return { level, source, pressureAllowed: false, pressureLevel: 'none' };
}

function commitment(id: string, dueAt: string | null, p = priority('normal', 'default')): Commitment {
  return {
    id, kind: 'task', title: id, description: null, person: null, status: 'active',
    priority: p,
    timeSpec: { kind: dueAt === null ? 'unscheduled' : 'due_by', dueAt, remindAt: dueAt, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:00:00.000Z',
    confirmedAt: '2026-09-01T09:00:00.000Z', completedAt: null, droppedAt: null,
  } as Commitment;
}

async function seed(commitments: Commitment[]): Promise<void> {
  const state = createEmptyDomainState();
  for (const item of commitments) state.commitments[item.id] = item;
  await persistParticipantState(UID, state);
}

function request(path: string): Request {
  return new Request(`${BASE}${path}`, { headers: new Headers({ authorization: `Bearer ${tokenFor(UID)}` }) });
}

async function todayItems(): Promise<Array<{ id: string; rank?: number; reasonCodes?: string[] }>> {
  const response = await todayGet(request(
    `/api/mobile/commitments/today?referenceTime=${REFERENCE}&timezone=UTC`,
  ));
  return (await response.json() as { items: Array<{ id: string; rank?: number; reasonCodes?: string[] }> }).items;
}

const DATED = [
  // Deliberately seeded out of order.
  commitment('mom', '2026-09-13T14:00:00.000Z', priority('high', 'user_explicit')),
  commitment('rent', '2026-09-13T08:00:00.000Z'),
  commitment('gym', '2026-09-13T20:00:00.000Z'),
];

test('with the flag on, Today comes back ranked, with reasons', async () => {
  begin('true');
  try {
    await seed(DATED);
    const items = await todayItems();
    assert.deepEqual(items.map((item) => item.id), ['rent', 'mom', 'gym']);
    assert.deepEqual(items.map((item) => item.rank), [0, 1, 2]);
    assert.deepEqual(items[0]!.reasonCodes, ['overdue']);
    assert.deepEqual(items[1]!.reasonCodes, ['due_today', 'user_must']);
  } finally {
    end();
  }
});

test('with the flag off, Today is exactly the time order it always was', async () => {
  begin('false');
  try {
    await seed(DATED);
    const items = await todayItems();
    assert.deepEqual(items.map((item) => item.id), ['rent', 'mom', 'gym']);
    // And carries neither field: absent means "this build does not rank",
    // which the client renders as time order rather than as rank 0.
    for (const item of items) {
      assert.equal(item.rank, undefined, `${item.id} carries a rank with the flag off`);
      assert.equal(item.reasonCodes, undefined, `${item.id} carries reason codes with the flag off`);
    }
  } finally {
    end();
  }
});

test('with the flag off, an item with no time is on Today too, and sorts last', async () => {
  // This test used to assert the opposite — "stays hidden, as before" — which
  // is #384: whether a commitment is *visible* was decided by the ranking
  // flag, and staging runs with it off. That made "Buy milk" reach no list at
  // all, the defect #169 closed. Membership is now the same under both
  // settings and only the order differs, which is all the flag was ever for.
  //
  // Last, because an item with no time ties with everything and the ranked
  // path already puts it after the dated items it ties with. The two orders
  // agreeing is what keeps turning the flag off from moving things about.
  begin('false');
  try {
    await seed([...DATED, commitment('milk', null)]);
    assert.deepEqual((await todayItems()).map((item) => item.id), ['rent', 'mom', 'gym', 'milk']);
  } finally {
    end();
  }
});

test('with the flag off, a commitment dated yesterday is on Today', async () => {
  // #383's other half, through the route this time. `REFERENCE` is the clock
  // the request carries, so nothing here depends on the day it is run.
  begin('false');
  try {
    const yesterday = new Date(Date.parse(REFERENCE) - 26 * 60 * 60 * 1000).toISOString();
    await seed([...DATED, commitment('passport', yesterday)]);
    assert.deepEqual((await todayItems()).map((item) => item.id), ['passport', 'rent', 'mom', 'gym']);
  } finally {
    end();
  }
});

test('with the flag on, an item with no time finally appears, and says why', async () => {
  begin('true');
  try {
    await seed([...DATED, commitment('milk', null)]);
    const items = await todayItems();
    const milk = items.find((item) => item.id === 'milk');
    assert.ok(milk, '"Buy milk" is still invisible on the phone');
    assert.deepEqual(milk.reasonCodes, ['no_deadline']);
    // And it is last: an undated item sorts after the dated ones it ties with.
    assert.equal(items[items.length - 1]!.id, 'milk');
  } finally {
    end();
  }
});

test('Upcoming never carries an undated item, whatever the flag says', async () => {
  begin('true');
  try {
    await seed([commitment('milk', null), commitment('later', '2026-09-20T09:00:00.000Z')]);
    const response = await upcomingGet(request(
      `/api/mobile/commitments/upcoming?referenceTime=${REFERENCE}&timezone=UTC`,
    ));
    const items = (await response.json() as { items: Array<{ id: string }> }).items;
    // "Upcoming" means a later day. An undated item has no later day to be on.
    assert.deepEqual(items.map((item) => item.id), ['later']);
  } finally {
    end();
  }
});

test('a user’s stated Must outranks a guess, through the route', async () => {
  begin('true');
  try {
    await seed([
      commitment('guessed', '2026-09-13T14:00:00.000Z', priority('high', 'inferred')),
      commitment('stated', '2026-09-13T14:00:00.000Z', priority('high', 'user_explicit')),
    ]);
    assert.deepEqual((await todayItems()).map((item) => item.id), ['stated', 'guessed']);
  } finally {
    end();
  }
});

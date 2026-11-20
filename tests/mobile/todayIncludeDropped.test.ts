/**
 * «الكل» on the commitments screen holds what was dropped on purpose
 * (simulator 2026-11-20, sim-1120 D; V3-F08-01).
 *
 * The app's «الكل» is built from `/commitments/today` and `/upcoming`, and
 * `placeInList` leaves a dropped commitment out of both (`isVisibleInLists`),
 * so the app's #878 filter never saw one: «الكل» was «لسّا» + «تمّت».
 *
 * `/today?include=dropped` adds them, on the day they were dropped — the rule
 * a finished commitment already follows (it is on the day it happened, in the
 * Finished group). Without the parameter nothing changes: Today, the plan,
 * the counts and the calendar sync read the same list as before, and an
 * unknown value is the client's to fix (400), not a silent default.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState, type Command } from '../../src/domain/stateMachine.ts';
import { applyParticipantCommand } from '../../lib/services/mobile/participantState.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { GET as upcomingGet } from '../../src/app/api/mobile/commitments/upcoming/route.ts';

const BASE = 'http://127.0.0.1:4321';
const USER = uidFor('TodayIncludeDroppedUser');
const ZONE = 'Asia/Jerusalem';
const NOW = '2026-11-20T09:00:00.000Z';
const EARLIER_TODAY = '2026-11-20T06:00:00.000Z';
const YESTERDAY = '2026-11-19T09:00:00.000Z';
const TOMORROW = '2026-11-21T09:00:00.000Z';

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

interface ListBody { items: { id: string; status: string }[]; calendarOrphans?: unknown[] }

async function list(path: 'today' | 'upcoming', extra = ''): Promise<{ status: number; body: ListBody }> {
  const query = `?referenceTime=${encodeURIComponent(NOW)}&timezone=${encodeURIComponent(ZONE)}${extra}`;
  const request = new Request(`${BASE}/api/mobile/commitments/${path}${query}`, { headers: { authorization: `Bearer ${tokenFor(USER)}` } });
  const response = await (path === 'today' ? todayGet(request) : upcomingGet(request));
  return { status: response.status, body: await response.json() as ListBody };
}

const ids = (body: ListBody) => body.items.map((item) => item.id).sort();

async function act(command: Command): Promise<void> {
  await applyParticipantCommand(USER, command);
}

/** A confirmed commitment; `dueAt: null` names no day (the sim's promoted idea). */
async function commitment(id: string, dueAt: string | null, kind: 'task' | 'event' = 'task'): Promise<void> {
  await act({
    type: 'CreateDraft',
    now: '2026-11-18T08:00:00.000Z',
    commitment: {
      id, kind, title: `Item ${id}`,
      timeSpec: dueAt === null
        ? { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: ZONE }
        : { kind: kind === 'event' ? 'scheduled_event' : 'due_by', dueAt, remindAt: null, timezone: ZONE },
    },
    draftStatus: 'pending_confirmation',
  } as Command);
  await act({ type: 'ConfirmCommitment', commitmentId: id, now: '2026-11-18T08:01:00.000Z' });
}

async function seed(): Promise<void> {
  await seedLiveAccount(USER);
  await commitment('open', TOMORROW);
  await commitment('open-today', null);
  // Dropped today: one undated (the simulator's «أرتّب أوراق الجامعة»), one due tomorrow.
  await commitment('dropped-undated', null);
  await act({ type: 'Drop', commitmentId: 'dropped-undated', now: EARLIER_TODAY });
  await commitment('dropped-tomorrow', TOMORROW);
  await act({ type: 'Drop', commitmentId: 'dropped-tomorrow', now: EARLIER_TODAY });
  // An appointment that already ended, dropped today: dropped is settled, like done.
  await commitment('dropped-ended-event', '2026-11-20T05:00:00.000Z', 'event');
  await act({ type: 'Drop', commitmentId: 'dropped-ended-event', now: EARLIER_TODAY });
  // Dropped yesterday: like something finished yesterday, it is no longer on a list.
  await commitment('dropped-yesterday', null);
  await act({ type: 'Drop', commitmentId: 'dropped-yesterday', now: YESTERDAY });
}

test('D: without the parameter Today and Upcoming hold no dropped commitment (unchanged)', async () => {
  const teardown = setup();
  try {
    await seed();
    const today = await list('today');
    assert.equal(today.status, 200);
    assert.deepEqual(ids(today.body), ['open-today']);
    assert.deepEqual(ids((await list('upcoming')).body), ['open']);
  } finally {
    teardown();
  }
});

test('D: /today?include=dropped adds what was dropped today, on the day it was dropped', async () => {
  const teardown = setup();
  try {
    await seed();
    const today = await list('today', '&include=dropped');
    assert.equal(today.status, 200);
    assert.deepEqual(ids(today.body), ['dropped-ended-event', 'dropped-tomorrow', 'dropped-undated', 'open-today']);
    for (const item of today.body.items) assert.equal(item.status, item.id.startsWith('dropped') ? 'dropped' : 'active');
    // Upcoming does not take the parameter's items: a drop is never on a later day.
    assert.deepEqual(ids((await list('upcoming')).body), ['open']);
    // The calendar sync's orphans are the account's, the same with or without it.
    assert.deepEqual(today.body.calendarOrphans ?? [], (await list('today')).body.calendarOrphans ?? []);
  } finally {
    teardown();
  }
});

test('D: an include value the route does not know is refused, naming it', async () => {
  const teardown = setup();
  try {
    await seed();
    for (const value of ['archived', 'all', '']) {
      const response = await list('today', `&include=${encodeURIComponent(value)}`);
      assert.equal(response.status, 400, `include=${value}`);
    }
  } finally {
    teardown();
  }
});

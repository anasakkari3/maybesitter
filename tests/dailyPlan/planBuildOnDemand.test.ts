/**
 * Building today's plan from the plan screen (#477).
 *
 * Before this, the only code that created a plan was the morning tick, so an
 * account whose morning had not run — delivery off, just switched on, a job
 * that failed or was never scheduled — opened the plan screen onto a dead end.
 *
 * The on-demand build is the morning build without the push: the same
 * `composeDailyPlan`, the same `createIfAbsent`, the same `plan_proposed`
 * ledger entry. These tests hold it to that, and hold the two callers to one
 * plan document between them when they race.
 *
 * The routes are invoked in-process, as `planActions.test.ts` does, on the
 * memory adapter the rest of the dailyPlan suite uses.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  PlanDateOutOfRangeError,
  buildDailyPlanOnDemand,
  runDailyPlanTick,
  savePlanSettings,
  type PlanReadyNotice,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import type { BusyBlockReader } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { MAX_PLAN_GENERATIONS_PER_DAY, MAX_PLAN_REBUILDS_PER_DAY } from '../../lib/services/dailyPlan/planSettings.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as buildPost } from '../../src/app/api/mobile/plans/[date]/build/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('BuildUser');
const DATE = '2026-09-15';
/** 09:00 in Jerusalem: after the 07:30 delivery, so the tick is due. */
const MORNING = new Date('2026-09-15T06:00:00.000Z');

function request(path: string, options: { body?: unknown; uid?: string; anonymous?: boolean } = {}): Request {
  const headers = new Headers();
  if (!options.anonymous) headers.set('authorization', `Bearer ${tokenFor(options.uid ?? USER)}`);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

function seedState() {
  let state = createEmptyDomainState();
  ['Write the summary', 'Call the bank', 'Book the train'].forEach((title, index) => {
    const id = `cmt_${index}`;
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  });
  return state;
}

/** An account with commitments and no plan. Delivery is off unless asked. */
async function seed(storage: StorageAdapter, uid: string, options: { delivery?: boolean; timezone?: string } = {}): Promise<void> {
  await persistParticipantState(uid, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: options.timezone ?? TZ, locale: 'en' });
  if (options.delivery) {
    await savePlanSettings(uid, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  }
}

function recorder() {
  const sent: PlanReadyNotice[] = [];
  return { sent, push: async (notice: PlanReadyNotice) => { sent.push(notice); } };
}

/** Counts composes: `composeDailyPlan` reads busy time exactly once per build. */
function countingBusy(): { calls: () => number; reader: BusyBlockReader } {
  let calls = 0;
  return { calls: () => calls, reader: async () => { calls += 1; return []; } };
}

interface Harness {
  storage: StorageAdapter;
  auth: FakeAuthControls;
}

/**
 * The route reads the real clock, so the route tests pin it to `MORNING`:
 * the build window is "today or tomorrow in the account zone", and a suite
 * that depended on the day it was run would not be a suite.
 */
async function withHarness(fn: (harness: Harness) => Promise<void>, now: Date = MORNING): Promise<void> {
  mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  try {
    await fn({ storage, auth });
  } finally {
    auth.restore();
    resetStorageForTests();
    mock.timers.reset();
  }
}

/* ── The shared build, without the push ──────────────────────────── */

test('an on-demand build stores generation 1, records plan_proposed once, and pushes nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER, { delivery: true });
    const push = recorder();

    const result = await buildDailyPlanOnDemand(USER, DATE, { storage, push: push.push, now: () => MORNING });

    assert.equal(result.created, true);
    assert.equal(result.pushed, false);
    assert.equal(push.sent.length, 0, 'a plan the user asked for on screen rang their phone');
    const stored = await readStoredPlan(USER, DATE, storage);
    assert.ok(stored, 'no plan was stored');
    assert.deepEqual(result.stored, stored);
    assert.equal(stored!.generation, 1);
    assert.equal(stored!.status, 'proposed');
    assert.equal(stored!.timezone, TZ, 'the plan was not built in the account\'s zone');
    assert.equal(stored!.plan.scheduled.length, 3);
    assert.deepEqual((await listPlanEvents(USER, storage)).map((event) => event.type), ['plan_proposed']);
  });
});

test('building again returns the stored plan, composes nothing and records nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const busy = countingBusy();
    const deps = { storage, push: recorder().push, busyBlocks: busy.reader, now: () => MORNING };

    const first = await buildDailyPlanOnDemand(USER, DATE, deps);
    assert.equal(busy.calls(), 1);
    const second = await buildDailyPlanOnDemand(USER, DATE, { ...deps, now: () => new Date('2026-09-15T08:00:00.000Z') });

    assert.equal(second.created, false);
    assert.deepEqual(second.stored, first.stored, 'a second build changed the stored plan');
    assert.equal(busy.calls(), 1, 'a second build composed a plan (and would have spent a model call) for nothing');
    assert.equal((await readStoredPlan(USER, DATE, storage))!.generation, 1);
    assert.equal((await listPlanEvents(USER, storage)).length, 1, 'a second build wrote a second plan_proposed');
  });
});

test('two builds at once leave one plan document and one plan_proposed', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const deps = { storage, push: recorder().push, now: () => MORNING };
    const [left, right] = await Promise.all([
      buildDailyPlanOnDemand(USER, DATE, deps),
      buildDailyPlanOnDemand(USER, DATE, deps),
    ]);
    assert.equal(Number(left.created) + Number(right.created), 1, 'both builds reported creating the plan');
    assert.deepEqual(left.stored, right.stored);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

test('a build with delivery off leaves the delivery settings exactly as they were', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const before = await storage.get<Record<string, unknown>>(userDoc(USER));
    const result = await buildDailyPlanOnDemand(USER, DATE, { storage, push: recorder().push, now: () => MORNING });
    assert.equal(result.created, true);
    const after = await storage.get<Record<string, unknown>>(userDoc(USER));
    assert.deepEqual(after?.planSettings, before?.planSettings, 'building a plan armed or changed the morning delivery');
  });
});

/* ── Racing the morning tick ─────────────────────────────────────── */

test('a build and then the morning tick: one plan, and the tick does not push a plan it did not create', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER, { delivery: true });
    const push = recorder();
    const built = await buildDailyPlanOnDemand(USER, DATE, { storage, push: push.push, now: () => MORNING });

    const totals = await runDailyPlanTick({ storage, push: push.push, now: () => MORNING });

    assert.equal(totals.claimed, 1, 'the morning was not claimed, so this proves nothing about the tick');
    assert.equal(totals.built, 0, 'the tick wrote over the plan the user built');
    assert.equal(totals.pushed, 0);
    assert.equal(push.sent.length, 0, 'the tick pushed for a plan it did not create');
    assert.deepEqual(await readStoredPlan(USER, DATE, storage), built.stored);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

test('a build and the morning tick at the same moment leave one plan and at most the tick\'s own push', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER, { delivery: true });
    const push = recorder();
    const [built, totals] = await Promise.all([
      buildDailyPlanOnDemand(USER, DATE, { storage, push: push.push, now: () => MORNING }),
      runDailyPlanTick({ storage, push: push.push, now: () => MORNING }),
    ]);

    assert.equal(Number(built.created) + totals.built, 1, 'the two callers did not leave exactly one plan');
    assert.equal(push.sent.length, totals.built, 'a push went out that the tick did not earn by creating the plan');
    assert.equal((await readStoredPlan(USER, DATE, storage))!.generation, 1);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

/* ── The route ───────────────────────────────────────────────────── */

test('POST build refuses a caller with no token', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const response = await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {}, anonymous: true }), params(DATE));
    assert.equal(response.status, 401);
    assert.equal(await readStoredPlan(USER, DATE, storage), null);
  });
});

test('POST build refuses a date that is not one, and writes nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    for (const date of ['tomorrow', '2026-02-30', '2026-9-15']) {
      const response = await buildPost(request(`/api/mobile/plans/${date}/build`, { body: {} }), params(date));
      assert.equal(response.status, 400, `${date} was accepted`);
    }
    assert.deepEqual(await listPlanEvents(USER, storage), []);
  });
});

test('POST build answers 200 with the plan GET then returns', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    assert.equal((await planGet(request(`/api/mobile/plans/${DATE}`), params(DATE))).status, 404);

    const response = await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE));
    assert.equal(response.status, 200);
    const built = await response.json() as { success: boolean; plan: { date: string; generation: number; scheduled: Array<{ title: string | null }> } };
    assert.equal(built.success, true);
    assert.equal(built.plan.date, DATE);
    assert.equal(built.plan.generation, 1);
    assert.deepEqual(
      built.plan.scheduled.map((item) => item.title).sort(),
      ['Book the train', 'Call the bank', 'Write the summary'],
    );

    const read = await planGet(request(`/api/mobile/plans/${DATE}`), params(DATE));
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), built, 'the build answered a different shape or plan than GET');
    assert.equal((await readStoredPlan(USER, DATE, storage))!.generation, 1);
  });
});

test('POST build on a date that already has a plan answers the same plan and records nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const first = await (await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE))).json();
    const again = await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), first);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

test('two POST builds racing leave one plan and one plan_proposed', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const responses = await Promise.all([
      buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE)),
      buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE)),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const [left, right] = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(left, right);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

test('one account\'s build does not touch another account\'s day', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const other = uidFor('OtherBuildUser');
    await seed(storage, other);
    await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {}, uid: other }), params(DATE));
    assert.equal(await readStoredPlan(USER, DATE, storage), null);
    assert.ok(await readStoredPlan(other, DATE, storage));
  });
});

test(`after a build, regenerate works and ${MAX_PLAN_REBUILDS_PER_DAY} rebuilds remain`, async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    assert.equal((await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE))).status, 200);

    for (let attempt = 1; attempt <= MAX_PLAN_REBUILDS_PER_DAY; attempt += 1) {
      const response = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { body: {} }), params(DATE));
      assert.equal(response.status, 200, `rebuild ${attempt} after an on-demand build was refused`);
      assert.equal((await response.json() as { plan: { generation: number } }).plan.generation, attempt + 1);
    }
    const capped = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { body: {} }), params(DATE));
    assert.equal(capped.status, 429, 'the on-demand build did not count toward the day\'s generations');
    assert.equal((await readStoredPlan(USER, DATE, storage))!.generation, MAX_PLAN_GENERATIONS_PER_DAY);

    // And a build after all that still spends nothing and changes nothing.
    const rebuilt = await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE));
    assert.equal(rebuilt.status, 200);
    assert.equal((await rebuilt.json() as { plan: { generation: number } }).plan.generation, MAX_PLAN_GENERATIONS_PER_DAY);
  });
});

/* ── The window: a creating build is today or tomorrow, in the account's zone ── */

async function refusedWithoutWriting(storage: StorageAdapter, uid: string, date: string, now: Date): Promise<void> {
  const busy = countingBusy();
  await assert.rejects(
    buildDailyPlanOnDemand(uid, date, { storage, push: recorder().push, busyBlocks: busy.reader, now: () => now }),
    (error: unknown) => error instanceof PlanDateOutOfRangeError,
    `${date} was built`,
  );
  assert.equal(busy.calls(), 0, `${date}: a plan was composed (and a model call could be spent) for a refused date`);
  assert.equal(await readStoredPlan(uid, date, storage), null, `${date}: a plan document was written`);
  assert.deepEqual(await listPlanEvents(uid, storage), [], `${date}: a ledger entry was written`);
}

test('a build for yesterday, the day after tomorrow, or a far date composes nothing and stores nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    for (const date of ['2026-09-14', '2026-09-17', '2026-09-30', '0001-01-01', '1999-12-31', '9999-12-31']) {
      await refusedWithoutWriting(storage, USER, date, MORNING);
    }
  });
});

test('POST build answers 400 date_out_of_range outside today and tomorrow, and writes nothing', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    for (const date of ['2026-09-14', '2026-09-17', '1999-12-31', '9999-12-31']) {
      const response = await buildPost(request(`/api/mobile/plans/${date}/build`, { body: {} }), params(date));
      assert.equal(response.status, 400, `${date} was accepted`);
      const body = await response.json() as { success: boolean; reason: string };
      assert.equal(body.success, false);
      assert.equal(body.reason, 'date_out_of_range');
      assert.equal(await readStoredPlan(USER, date, storage), null);
    }
    assert.deepEqual(await listPlanEvents(USER, storage), []);
  });
});

test('POST build for tomorrow creates it', async () => {
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    const response = await buildPost(request('/api/mobile/plans/2026-09-16/build', { body: {} }), params('2026-09-16'));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { plan: { date: string; generation: number } }).plan.generation, 1);
    assert.ok(await readStoredPlan(USER, '2026-09-16', storage));
  });
});

test('a plan already stored for a date outside the window is returned, not refused', async () => {
  let yesterday: unknown;
  // Built the day it was today…
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    yesterday = await (await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE))).json();
    // …and asked for again two days later, in the same store.
    mock.timers.setTime(Date.parse('2026-09-17T06:00:00.000Z'));
    const busy = countingBusy();
    const direct = await buildDailyPlanOnDemand(USER, DATE, {
      storage, busyBlocks: busy.reader, now: () => new Date('2026-09-17T06:00:00.000Z'),
    });
    assert.equal(direct.created, false);
    assert.equal(busy.calls(), 0);
    const again = await buildPost(request(`/api/mobile/plans/${DATE}/build`, { body: {} }), params(DATE));
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), yesterday);
    assert.equal((await listPlanEvents(USER, storage)).length, 1);
  });
});

test('the window is the account\'s day, not UTC\'s: west of UTC', async () => {
  // 02:00 UTC on the 16th is 19:00 on the 15th in Los Angeles.
  const now = new Date('2026-09-16T02:00:00.000Z');
  await withHarness(async ({ storage }) => {
    await seed(storage, USER, { timezone: 'America/Los_Angeles' });
    await refusedWithoutWriting(storage, USER, '2026-09-17', now); // UTC's tomorrow, the account's day after
    const today = await buildPost(request('/api/mobile/plans/2026-09-15/build', { body: {} }), params('2026-09-15'));
    assert.equal(today.status, 200, 'the account\'s today was refused because UTC had moved on');
    const tomorrow = await buildPost(request('/api/mobile/plans/2026-09-16/build', { body: {} }), params('2026-09-16'));
    assert.equal(tomorrow.status, 200);
  }, now);
});

test('the window is the account\'s day, not UTC\'s: east of UTC', async () => {
  // 22:30 UTC on the 15th is 01:30 on the 16th in Jerusalem.
  const now = new Date('2026-09-15T22:30:00.000Z');
  await withHarness(async ({ storage }) => {
    await seed(storage, USER);
    await refusedWithoutWriting(storage, USER, '2026-09-15', now); // UTC's today, the account's yesterday
    const tomorrow = await buildPost(request('/api/mobile/plans/2026-09-17/build', { body: {} }), params('2026-09-17'));
    assert.equal(tomorrow.status, 200, 'the account\'s tomorrow was refused because UTC had not got there');
  }, now);
});

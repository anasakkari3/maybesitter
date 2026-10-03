/**
 * An empty plan cannot be accepted, and is never a planned day (black-box
 * audit 2026-10-03, #4; screens 19 and 47).
 *
 * The audit's account, on Saturday 3 October: the only commitment was the
 * exam tomorrow at 10:00. Plan → today → «اعمل خطة اليوم» said «ما في إشي
 * محطوط بوقت اليوم», but «اقبل الخطة» answered «حفظنا خطة اليوم», and
 * Settings → «نشاطي» then showed «يوم واحد إله خطة» and «أول خطة قبلتها».
 *
 * Driven through the routes the phone calls: build, accept, the week's
 * accept, and the activity summary.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { POST as buildPost } from '../../src/app/api/mobile/plans/[date]/build/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as weekPost } from '../../src/app/api/mobile/plans/week/route.ts';
import { POST as weekAcceptPost } from '../../src/app/api/mobile/plans/week/accept/route.ts';
import { GET as summaryGet } from '../../src/app/api/mobile/activity/summary/route.ts';
import { replaceBusyBlocksAsFixture } from '../support/busyFixtures.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('EmptyPlanUser');
const TODAY = '2026-10-03';
/** 12:15 in Jerusalem, when the audit pressed «اعمل خطة اليوم». */
const NOW = new Date('2026-10-03T09:15:00.000Z');

function request(path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(USER)}` });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const params = (date: string) => ({ params: Promise.resolve({ date }) });

async function withHarness(run: (storage: StorageAdapter) => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['Date'], now: NOW.getTime() });
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  try {
    const user = await storage.get<Record<string, unknown>>(userDoc(USER));
    await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'ar' });
    await run(storage);
  } finally {
    auth.restore();
    resetStorageForTests();
    mock.timers.reset();
  }
}

async function capture(text: string): Promise<void> {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() }, { participantId: USER });
  const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: proposal.items.map((item) => item.itemId) }, { participantId: USER });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
}

async function summary(): Promise<{ plannedDaysCount: number; moments: Array<{ id: string }> }> {
  return await (await summaryGet(request('/api/mobile/activity/summary?weekStart=2026-09-28'))).json() as never;
}

test('#4: today\'s plan with nothing on it is refused, and «نشاطي» counts no planned day and no first plan', async () => {
  await withHarness(async (storage) => {
    await capture('عندي امتحان رياضيات بكرا الساعة 10');
    const built = await buildPost(request(`/api/mobile/plans/${TODAY}/build`, {}), params(TODAY));
    assert.equal(built.status, 200);
    const plan = (await built.json() as { plan: { scheduled: unknown[]; status: string } }).plan;
    assert.deepEqual([plan.scheduled.length, plan.status], [0, 'proposed'], 'the setup is not the audit\'s empty day');

    const accepted = await actionPost(request(`/api/mobile/plans/${TODAY}/actions`, { action: 'accept' }), params(TODAY));
    assert.equal(accepted.status, 422, 'an empty plan was accepted');
    assert.equal((await accepted.json() as { reason: string }).reason, 'empty_plan');

    // Nothing was written: not the status, not the ledger, not the counter.
    assert.equal((await readStoredPlan(USER, TODAY, storage))!.status, 'proposed');
    assert.ok(!(await listPlanEvents(USER, storage)).some((event) => event.type === 'plan_accepted'));
    const week = await summary();
    assert.equal(week.plannedDaysCount, 0, '«يوم واحد إله خطة» for a day with nothing planned');
    assert.ok(!week.moments.some((moment) => moment.id === 'first_plan_accepted'), '«أول خطة قبلتها» for an empty plan');
  });
});

test('#4: a plan with a step on it is still accepted, and counted', async () => {
  await withHarness(async () => {
    await capture('لازم أبعت التقرير اليوم قبل الساعة 6 المسا');
    await buildPost(request(`/api/mobile/plans/${TODAY}/build`, {}), params(TODAY));
    const accepted = await actionPost(request(`/api/mobile/plans/${TODAY}/actions`, { action: 'accept' }), params(TODAY));
    assert.equal(accepted.status, 200);
    const week = await summary();
    assert.equal(week.plannedDaysCount, 1);
    assert.ok(week.moments.some((moment) => moment.id === 'first_plan_accepted'));
  });
});

test('#4: the week cannot save an empty day either', async () => {
  await withHarness(async (storage) => {
    await capture('عندي امتحان رياضيات بكرا الساعة 10');
    const shown = (await (await weekPost(request('/api/mobile/plans/week', {}))).json() as { week: { days: Array<{ date: string; items: Array<{ itemId: string }> }> } }).week;
    const today = shown.days.find((day) => day.date === TODAY)!;
    assert.equal(today.items.length, 0, 'the setup is not an empty day');
    const response = await weekAcceptPost(request('/api/mobile/plans/week/accept', { date: TODAY, shown: [] }));
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { reason: string }).reason, 'empty_plan');
    assert.equal(await readStoredPlan(USER, TODAY, storage), null, 'an empty day was stored as a plan');
    assert.equal((await summary()).plannedDaysCount, 0);
  });
});

test('review of #4: a step moved onto a day it no longer fits is refused with 422, and leaves no plan behind', async () => {
  await withHarness(async (storage) => {
    await capture('لازم أبعت التقرير اليوم قبل الساعة 6 المسا');
    const [report] = Object.values((await getParticipantStateSnapshot(USER)).commitments);
    const DAY = '2026-10-05';
    // Monday is wall-to-wall busy on the calendar.
    await replaceBusyBlocksAsFixture(USER, 'device:cal-1', { startsAt: '2026-10-04T21:00:00.000Z', endsAt: '2026-10-05T21:00:00.000Z' }, [{
      blockId: 'busy-all-day', sourceId: 'device:cal-1', sourceKind: 'device' as const,
      startAt: '2026-10-04T21:00:00.000Z', endAt: '2026-10-05T20:59:00.000Z', allDay: false,
    }], { storage });
    const moves = [{ itemId: report!.id, date: DAY }];
    const shown = (await (await weekPost(request('/api/mobile/plans/week', { moves, drops: [] }))).json() as { week: { days: Array<{ date: string; items: Array<{ itemId: string }>; unplaced: Array<{ itemId: string }> }> } }).week;
    const monday = shown.days.find((day) => day.date === DAY)!;
    assert.deepEqual([monday.items.length, monday.unplaced.map((item) => item.itemId)], [0, [report!.id]], 'the setup is not the reviewer\'s day');

    const response = await weekAcceptPost(request('/api/mobile/plans/week/accept', {
      date: DAY, shown: monday.unplaced.map((item) => item.itemId), moves, drops: [],
    }));
    assert.equal(response.status, 422, `answered ${response.status}`);
    assert.equal((await response.json() as { reason: string }).reason, 'empty_plan');
    assert.equal(await readStoredPlan(USER, DAY, storage), null, 'an empty plan was left stored');
    // Refused before anything was built: not even a proposal in the ledger.
    assert.ok(!(await listPlanEvents(USER, storage)).some((event) => event.date === DAY), 'the empty day was built and stored first');
    assert.equal((await summary()).plannedDaysCount, 0);
  });
});

/**
 * An end nobody stated is not shown as a fact (black-box audit 2026-10-03,
 * #11; screen 27).
 *
 * «عندي امتحان رياضيات بكرا الساعة 10» names a start and no length. The week
 * plan drew it «10:00–10:30 ثابت»: the half hour is the planner's reservation
 * (`DEFAULT_FIXED_EVENT_MINUTES`), which it still needs to keep the time, but
 * nobody said the exam ends at 10:30. The fixed row now says its end is an
 * estimate; a commitment that states its end says nothing of the kind.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor } from '../support/fakeAuth.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { DEFAULT_FIXED_EVENT_MINUTES } from '../../lib/services/dailyPlan/buildDailyPlan.ts';
import { POST as weekPost } from '../../src/app/api/mobile/plans/week/route.ts';
import { POST as buildPost } from '../../src/app/api/mobile/plans/[date]/build/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('FixedEndUser');
const NOW = new Date('2026-10-03T09:21:00.000Z'); // 12:21, screen 27
const TOMORROW = '2026-10-04';

interface Row { itemId: string; title: string | null; startsAt: string; endsAt: string; endEstimated?: boolean }

function request(path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(USER)}`, 'content-type': 'application/json' });
  return new Request(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
}

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

async function fixedOnTomorrowInWeek(): Promise<Row[]> {
  const body = await (await weekPost(request('/api/mobile/plans/week'))).json() as { week: { days: Array<{ date: string; fixed: Row[] }> } };
  return body.week.days.find((day) => day.date === TOMORROW)!.fixed;
}

test('#11: the exam with no stated length is drawn at its start, its end marked as the planner\'s estimate', async () => {
  await withHarness(async () => {
    await capture('عندي امتحان رياضيات بكرا الساعة 10');
    const [exam] = await fixedOnTomorrowInWeek();
    assert.ok(exam, 'the exam is not on tomorrow');
    assert.equal(exam.startsAt, '2026-10-04T07:00:00.000Z');
    // The reservation stays — the planner still keeps the time…
    assert.equal(Date.parse(exam.endsAt) - Date.parse(exam.startsAt), DEFAULT_FIXED_EVENT_MINUTES * 60_000);
    // …but it is not presented as the exam's length.
    assert.equal(exam.endEstimated, true, '10:00–10:30 presented as fact');

    const built = await buildPost(request(`/api/mobile/plans/${TOMORROW}/build`), { params: Promise.resolve({ date: TOMORROW }) });
    const day = await built.json() as { plan: { fixed: Row[] } };
    assert.equal(day.plan.fixed.find((row) => row.itemId === exam.itemId)?.endEstimated, true, 'the day plan says the same');
  });
});

test('#11: an event whose end was said keeps its range as fact', async () => {
  await withHarness(async () => {
    await capture('عندي امتحان رياضيات بكرا من الساعة 10 للساعة 12');
    const [exam] = await fixedOnTomorrowInWeek();
    assert.ok(exam);
    assert.equal(exam.endsAt, '2026-10-04T09:00:00.000Z');
    assert.equal(exam.endEstimated, undefined);
  });
});

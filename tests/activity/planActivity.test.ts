/**
 * An accepted plan, in the history and the week (UC-3.15 #201, fed by UC-3.10a #194).
 *
 * #194 landed after the activity server half and keeps its decisions in its
 * own ledger, `users/{uid}/planEvents`, deliberately not in the domain log the
 * reducer replays. So a `plan_accepted` never reached `users/{uid}/events`, and
 * the activity routes — which read only that log — could not see one: the
 * history had no entry, "days with a plan" was zero for everyone, and the
 * first-plan Moment was unreachable.
 *
 * These go through the real plan actions and the real routes. A test that
 * hand-wrote a `plan_accepted` into the domain log would pass while no product
 * path ever wrote one there, which is the exact state this file exists to end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { UserDocument } from '../../lib/storage/userDocument.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { composeDailyPlan } from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { appendPlanEvent, createIfAbsent } from '../../lib/services/dailyPlan/planStore.ts';
import { acceptPlan, dismissPlan, editPlan, regeneratePlan } from '../../lib/services/dailyPlan/planActions.ts';
import { activityStatsPath } from '../../lib/services/activity/activityStats.ts';
import {
  ACTIVITY_KIND_BY_PLAN_EVENT_TYPE,
  PLAN_EVENTS_NOT_USER_FACING,
} from '../../lib/services/activity/planActivity.ts';
import { GET as activityGet } from '../../src/app/api/mobile/activity/route.ts';
import { GET as summaryGet } from '../../src/app/api/mobile/activity/summary/route.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'http://127.0.0.1:4321';
const OWNER = uidFor('PlanActivityOwner');
const STRANGER = uidFor('PlanActivityStranger');
const ZONE = 'Asia/Jerusalem';

let auth: FakeAuthControls | null = null;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
}

function end(): void {
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function request(uid: string, path: string): Request {
  return new Request(`${BASE}${path}`, { headers: { authorization: `Bearer ${tokenFor(uid)}` } });
}

async function json(response: Response): Promise<Record<string, any>> {
  assert.equal(response.status, 200);
  return await response.json() as Record<string, any>;
}

async function setProfile(uid: string, locale: 'ar' | 'en' | 'he'): Promise<void> {
  const storage = getStorage();
  const existing = await storage.get<UserDocument>(userDoc(uid));
  await storage.set<UserDocument>(userDoc(uid), { ...(existing as UserDocument), timezone: ZONE, locale });
}

/**
 * One confirmed task, so the plan has something to place. The confirm is a
 * minute after the capture unless `sameInstant`, which the paging test uses to
 * put three records on one instant across both collections.
 */
async function seedTask(uid: string, id: string, at: string, sameInstant = false): Promise<void> {
  const confirmedAt = sameInstant ? at : new Date(Date.parse(at) + 60_000).toISOString();
  await applyParticipantCommands(uid, [
    {
      type: 'CreateDraft',
      now: at,
      commitment: { id, kind: 'task', title: `Task ${id}`, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: ZONE } },
    },
    { type: 'ConfirmCommitment', commitmentId: id, now: confirmedAt },
  ]);
}

/** A plan for `date`, built the way the morning job builds one. */
async function buildPlan(uid: string, date: string, morning: string): Promise<void> {
  const storage = getStorage();
  const document = await composeDailyPlan(uid, date, { timezone: ZONE }, 1, { storage, now: () => new Date(morning) });
  await createIfAbsent(uid, document, storage);
}

async function history(uid: string, query = ''): Promise<Array<Record<string, any>>> {
  return (await json(await activityGet(request(uid, `/api/mobile/activity${query}`)))).items;
}

async function summary(uid: string, weekStart: string): Promise<Record<string, any>> {
  return json(await summaryGet(request(uid, `/api/mobile/activity/summary?weekStart=${weekStart}`)));
}

/* ── The ledger's own allowlist ───────────────────────────────────── */

/** Every member of `PlanEventType` as `planStore.ts` declares it. */
function declaredPlanEventTypes(): string[] {
  const source = readFileSync(join(repoRoot, 'lib/services/dailyPlan/planStore.ts'), 'utf8');
  const declaration = /export type PlanEventType\s*=([^;]+);/.exec(source);
  assert.ok(declaration, 'PlanEventType is no longer declared where this test reads it');
  return Array.from(declaration[1]!.matchAll(/'([a-z_]+)'/g)).map((match) => match[1]!).sort();
}

test('every plan ledger event is either mapped or declared not user-facing', () => {
  const declared = declaredPlanEventTypes();
  assert.ok(declared.length >= 5, `parsed only ${declared.length} plan event types; this check would be vacuous`);
  const undecided = declared.filter((type) =>
    ACTIVITY_KIND_BY_PLAN_EVENT_TYPE[type] === undefined && PLAN_EVENTS_NOT_USER_FACING[type] === undefined);
  assert.deepEqual(undecided, [], 'a new plan ledger event is neither mapped nor declared not user-facing');
  const both = declared.filter((type) =>
    ACTIVITY_KIND_BY_PLAN_EVENT_TYPE[type] !== undefined && PLAN_EVENTS_NOT_USER_FACING[type] !== undefined);
  assert.deepEqual(both, []);
  const stale = Object.keys(PLAN_EVENTS_NOT_USER_FACING).filter((type) => !declared.includes(type));
  assert.deepEqual(stale, [], 'these exclusions name plan events that no longer exist');
  assert.deepEqual(Object.entries(ACTIVITY_KIND_BY_PLAN_EVENT_TYPE), [['plan_accepted', 'plan_accepted']]);
});

/* ── The history ─────────────────────────────────────────────────── */

test('accepting a plan appears in the history, naming the day it was for', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T05:30:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:00:00.000Z') });

    const items = await history(OWNER);
    const plan = items.filter((item) => item.kind === 'plan_accepted');
    assert.equal(plan.length, 1, 'an accepted plan did not reach the history');
    assert.equal(plan[0]!.at, '2026-09-14T06:00:00.000Z');
    assert.equal(plan[0]!.commitmentId, null);
    assert.equal(plan[0]!.commitmentTitle, null);
    assert.deepEqual(plan[0]!.detail, { planDate: '2026-09-14' });
    // Newest first, and interleaved with the domain log rather than appended.
    assert.deepEqual(items.map((item) => item.kind), ['plan_accepted', 'confirmed', 'captured']);
  } finally {
    end();
  }
});

test('the plan the system proposed, and a plan set aside, never appear', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T05:30:00.000Z');
    // `plan_proposed` is in the ledger from the build. Dismiss writes
    // `plan_dismissed`, regenerate `plan_regenerated`, edit `plan_edited`.
    await appendPlanEvent(OWNER, {
      type: 'plan_proposed', date: '2026-09-14', at: '2026-09-14T05:30:00.000Z', generation: 1, inputDigest: 'x',
    });
    await dismissPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:00:00.000Z') });
    await regeneratePlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:10:00.000Z') });
    await editPlan(OWNER, '2026-09-14', { moves: [], removals: [] }, {}).catch(() => null);

    const kinds = (await history(OWNER)).map((item) => item.kind);
    assert.deepEqual(kinds, ['confirmed', 'captured']);
    const week = await summary(OWNER, '2026-09-13');
    assert.equal(week.plannedDaysCount, 0, 'a dismissed plan counted as a day with a plan');
    assert.deepEqual(week.moments.map((moment: { id: string }) => moment.id), ['first_capture']);
  } finally {
    end();
  }
});

test('one account never sees another account’s accepted plan', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T05:30:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:00:00.000Z') });

    assert.deepEqual(await history(STRANGER), []);
    const week = await summary(STRANGER, '2026-09-13');
    assert.equal(week.plannedDaysCount, 0);
    assert.deepEqual(week.moments, []);
  } finally {
    end();
  }
});

test('pages walk both logs together: stable, non-overlapping, nothing lost', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    const expected: string[] = [];
    for (let day = 0; day < 5; day += 1) {
      const date = `2026-09-1${day + 1}`;
      // The capture, the confirm and the acceptance share one instant on
      // purpose: a tie across the two collections is the case a naive merge
      // gets wrong.
      const at = `${date}T06:00:00.000Z`;
      await seedTask(OWNER, `c${day}`, at, true);
      await buildPlan(OWNER, date, at);
      await acceptPlan(OWNER, date, { now: () => new Date(at) });
    }
    const all = await history(OWNER, '?limit=50');
    for (const item of all) expected.push(item.id as string);
    assert.equal(all.filter((item) => item.kind === 'plan_accepted').length, 5);
    assert.equal(all.length, 15);

    for (const size of [1, 2, 4, 7]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 40; page += 1) {
        const body = await json(await activityGet(request(
          OWNER, `/api/mobile/activity?limit=${size}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        )));
        seen.push(...(body.items as Array<{ id: string }>).map((item) => item.id));
        cursor = body.nextCursor as string | null;
        if (cursor === null) break;
      }
      assert.deepEqual(seen, expected, `pages of ${size} did not walk the same history`);
    }
  } finally {
    end();
  }
});

/* ── The week and the Moment ─────────────────────────────────────── */

test('days with an accepted plan are counted once per local day', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-13T05:00:00.000Z');
    // Sunday 13 – Saturday 19 September, Asia/Jerusalem (UTC+3).
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T05:00:00.000Z') });
    // Accepted again the same day: still one day.
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T09:00:00.000Z') });
    // 22:30 UTC on the 15th is already the 16th in Jerusalem.
    await buildPlan(OWNER, '2026-09-16', '2026-09-15T22:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-16', { now: () => new Date('2026-09-15T22:30:00.000Z') });
    // Last week: not this week's.
    await buildPlan(OWNER, '2026-09-10', '2026-09-10T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-10', { now: () => new Date('2026-09-10T05:00:00.000Z') });

    assert.equal((await summary(OWNER, '2026-09-13')).plannedDaysCount, 2);
    assert.equal((await summary(OWNER, '2026-09-06')).plannedDaysCount, 1);
  } finally {
    end();
  }
});

test('the first accepted plan is a Moment, advanced in the same write as the ledger entry', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-13T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T05:00:00.000Z') });
    await buildPlan(OWNER, '2026-09-15', '2026-09-15T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-15', { now: () => new Date('2026-09-15T05:00:00.000Z') });

    const stats = await getStorage().get<{ firstPlanAcceptedAt: string | null }>(activityStatsPath(OWNER));
    assert.equal(stats?.firstPlanAcceptedAt, '2026-09-14T05:00:00.000Z');

    // Next week, with nothing in it: the Moment is still there.
    const week = await summary(OWNER, '2026-09-20');
    const moment = (week.moments as Array<{ id: string; reachedAt: string }>).find((entry) => entry.id === 'first_plan_accepted');
    assert.deepEqual(moment, { id: 'first_plan_accepted', reachedAt: '2026-09-14T05:00:00.000Z' });
  } finally {
    end();
  }
});

test('a plan accepted before this counter existed still reaches its Moment', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    // Exactly what #194 wrote: a ledger entry, and no counter at all.
    await appendPlanEvent(OWNER, {
      type: 'plan_proposed', date: '2026-09-10', at: '2026-09-10T04:00:00.000Z', generation: 1, inputDigest: 'legacy',
    });
    await appendPlanEvent(OWNER, {
      type: 'plan_accepted', date: '2026-09-10', at: '2026-09-10T05:00:00.000Z', generation: 1, inputDigest: 'legacy',
    });
    assert.equal(await getStorage().get(activityStatsPath(OWNER)), null);

    const week = await summary(OWNER, '2026-09-13');
    assert.deepEqual(
      (week.moments as Array<{ id: string; reachedAt: string }>).filter((entry) => entry.id === 'first_plan_accepted'),
      [{ id: 'first_plan_accepted', reachedAt: '2026-09-10T05:00:00.000Z' }],
    );

    // A later acceptance through the real path must not move it forward.
    await seedTask(OWNER, 'c1', '2026-09-14T03:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T05:00:00.000Z') });
    const after = await summary(OWNER, '2026-09-13');
    assert.equal(
      (after.moments as Array<{ id: string; reachedAt: string }>).find((entry) => entry.id === 'first_plan_accepted')?.reachedAt,
      '2026-09-10T05:00:00.000Z',
    );
    assert.equal(after.plannedDaysCount, 1);
    assert.equal((await summary(OWNER, '2026-09-06')).plannedDaysCount, 1, 'the legacy entry is a day with a plan too');
  } finally {
    end();
  }
});

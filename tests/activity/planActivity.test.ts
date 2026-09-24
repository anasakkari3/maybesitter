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
import { appendPlanEvent, createIfAbsent, readStoredPlan, storePlanProposal } from '../../lib/services/dailyPlan/planStore.ts';
import {
  acceptPlan,
  acceptPlanProposal,
  dismissPlan,
  editPlan,
  regeneratePlan,
  rejectPlanProposal,
} from '../../lib/services/dailyPlan/planActions.ts';
import { diffPlans } from '../../lib/planning/scheduler/index.ts';
import { activityStatsPath } from '../../lib/services/activity/activityStats.ts';
import { LEGACY_PLAN_SCAN, listActivitySources } from '../../lib/services/activity/activityService.ts';
import { compareEventsNewestFirst, MAX_EVENT_PAGE } from '../../lib/services/mobile/eventLog.ts';
import { deleteParticipantDomainState } from '../../lib/services/mobile/participantState.ts';
import { EVENTS, PLAN_EVENTS, sortableDocId, userCol } from '../../lib/storage/paths.ts';
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
  const members = Array.from(declaration[1]!.matchAll(/['"]([A-Za-z0-9_]+)['"]/g)).map((match) => match[1]!).sort();
  // Every union member must have been read. A member the pattern cannot see
  // (another quote style, a digit, a capital) would otherwise be undecided and
  // silently absent from this check.
  const unionMembers = declaration[1]!.split('|').map((part) => part.trim()).filter((part) => part !== '');
  assert.equal(members.length, unionMembers.length, `parsed ${members.length} of ${unionMembers.length} PlanEventType members`);
  return members;
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
  assert.deepEqual(Object.entries(ACTIVITY_KIND_BY_PLAN_EVENT_TYPE), [
    ['plan_accepted', 'plan_accepted'],
    ['plan_proposal_accepted', 'plan_proposal_accepted'],
  ]);
});

test('the two answers to a proposed change are decided, in opposite directions (#587)', () => {
  // Accepting is something the person did: shown. Declining is recorded for
  // the Trust surface and the re-raise guard, and kept out of this history
  // for the reason a dismissed plan is.
  assert.equal(ACTIVITY_KIND_BY_PLAN_EVENT_TYPE.plan_proposal_accepted, 'plan_proposal_accepted');
  assert.equal(PLAN_EVENTS_NOT_USER_FACING.plan_proposal_accepted, undefined);
  assert.equal(ACTIVITY_KIND_BY_PLAN_EVENT_TYPE.plan_proposal_rejected, undefined);
  assert.match(PLAN_EVENTS_NOT_USER_FACING.plan_proposal_rejected ?? '', /refusals/);
  // And the system fact written beside an acceptance stays hidden, so the
  // acceptance is shown once.
  assert.equal(ACTIVITY_KIND_BY_PLAN_EVENT_TYPE.plan_regenerated, undefined);
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

/* ── A proposed change, answered (#587) ─────────────────────────── */

/** Offers a patch of the stored plan the way the replan tick stores one: every item an hour later. */
async function offerChange(uid: string, date: string, proposedAt: string): Promise<void> {
  const storage = getStorage();
  const stored = await readStoredPlan(uid, date, storage);
  assert.ok(stored, 'fixture: no plan to patch');
  const later = (interval: { startsAt: string; endsAt: string }) => ({
    startsAt: new Date(Date.parse(interval.startsAt) + 3_600_000).toISOString(),
    endsAt: new Date(Date.parse(interval.endsAt) + 3_600_000).toISOString(),
  });
  const plan = {
    ...stored.plan,
    scheduled: stored.plan.scheduled.map((item) => ({ ...item, interval: later(item.interval), reservedInterval: later(item.reservedInterval) })),
  };
  const offered = await storePlanProposal(uid, date, {
    proposalId: 'prp_activity',
    proposedAt,
    baseGeneration: stored.generation,
    baseInputDigest: stored.inputDigest,
    plan,
    diff: diffPlans(stored.plan, plan),
    reason: 'user_requires_confirmation',
    userControlMode: 'always_require_confirmation',
    causeChangeIds: ['chg-meeting'],
  }, storage);
  assert.ok(offered?.proposal, 'fixture: the patch was not stored');
}

test('accepting a proposed change appears in the history once, naming the day (#587)', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T05:30:00.000Z');
    await offerChange(OWNER, '2026-09-14', '2026-09-14T06:00:00.000Z');
    await acceptPlanProposal(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:10:00.000Z') });

    const items = await history(OWNER);
    // Once: the `plan_regenerated` written in the same commit is not activity.
    assert.deepEqual(items.map((item) => item.kind), ['plan_proposal_accepted', 'confirmed', 'captured']);
    const [change] = items;
    assert.equal(change!.at, '2026-09-14T06:10:00.000Z');
    assert.equal(change!.commitmentId, null);
    assert.equal(change!.commitmentTitle, null);
    assert.deepEqual(change!.detail, { planDate: '2026-09-14' });
  } finally {
    end();
  }
});

test('accepting a change is not accepting the day: no planned day, no first-plan Moment (#587)', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T05:30:00.000Z');
    await offerChange(OWNER, '2026-09-14', '2026-09-14T06:00:00.000Z');
    await acceptPlanProposal(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:10:00.000Z') });

    const week = await summary(OWNER, '2026-09-13');
    assert.equal(week.plannedDaysCount, 0);
    assert.deepEqual(week.moments.map((moment: { id: string }) => moment.id), ['first_capture']);
    const stats = await getStorage().get<{ firstPlanAcceptedAt: string | null }>(activityStatsPath(OWNER));
    assert.equal(stats?.firstPlanAcceptedAt ?? null, null);
  } finally {
    end();
  }
});

test('declining a proposed change is recorded but never appears in the history (#587)', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T05:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T05:30:00.000Z');
    await offerChange(OWNER, '2026-09-14', '2026-09-14T06:00:00.000Z');
    await rejectPlanProposal(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T06:10:00.000Z') });

    // The premise: it is in the ledger, so leaving it out here is a decision.
    const ledger = await getStorage().list<{ type: string }>(userCol(OWNER, PLAN_EVENTS));
    assert.ok(ledger.some((row) => row.data.type === 'plan_proposal_rejected'));

    assert.deepEqual((await history(OWNER)).map((item) => item.kind), ['confirmed', 'captured']);
    assert.equal((await summary(OWNER, '2026-09-13')).plannedDaysCount, 0);
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

test('the counter answers for an acceptance further into the ledger than the legacy scan reads', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    // More rebuilds than the scan reads, all older than the acceptance.
    for (let index = 0; index < LEGACY_PLAN_SCAN + 5; index += 1) {
      await appendPlanEvent(OWNER, {
        type: 'plan_regenerated', date: '2026-09-01', at: new Date(Date.parse('2026-09-01T04:00:00.000Z') + index * 60_000).toISOString(),
        generation: 1, inputDigest: 'rebuilt',
      });
    }
    await seedTask(OWNER, 'c1', '2026-09-14T03:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T05:00:00.000Z') });

    const week = await summary(OWNER, '2026-09-20');
    assert.deepEqual(
      (week.moments as Array<{ id: string; reachedAt: string }>).filter((entry) => entry.id === 'first_plan_accepted'),
      [{ id: 'first_plan_accepted', reachedAt: '2026-09-14T05:00:00.000Z' }],
    );
  } finally {
    end();
  }
});

test('a long run of rebuilt plans does not hide an older acceptance behind an empty page', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await appendPlanEvent(OWNER, {
      type: 'plan_accepted', date: '2026-09-01', at: '2026-09-01T05:00:00.000Z', generation: 1, inputDigest: 'kept',
    });
    // A full page and more of ledger rows nobody is shown, all newer, and no
    // domain events at all to fill the page instead.
    for (let index = 0; index < MAX_EVENT_PAGE + 5; index += 1) {
      await appendPlanEvent(OWNER, {
        type: 'plan_regenerated', date: '2026-09-02', at: new Date(Date.parse('2026-09-02T04:00:00.000Z') + index * 60_000).toISOString(),
        generation: 2, inputDigest: 'rebuilt',
      });
    }

    const items = await history(OWNER);
    assert.deepEqual(items.map((item) => [item.kind, item.detail]), [['plan_accepted', { planDate: '2026-09-01' }]]);
  } finally {
    end();
  }
});

test('a ledger row named like a domain event is judged by the ledger allowlist, not the log’s', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    // Not something #194 writes today — the guard is against the day a ledger
    // type and a domain type share a name.
    const { PLAN_EVENTS, userCol } = await import('../../lib/storage/paths.ts');
    await getStorage().set(`${userCol(OWNER, PLAN_EVENTS)}/collides`, {
      id: 'collides', type: 'commitment_completed', date: '2026-09-14', at: '2026-09-14T05:00:00.000Z',
      generation: 1, inputDigest: 'x',
    });

    assert.deepEqual(await history(OWNER), []);
    const week = await summary(OWNER, '2026-09-13');
    assert.deepEqual([week.completedCount, week.plannedDaysCount], [0, 0]);
  } finally {
    end();
  }
});

/* ── The merged page, at sizes where the merge spills over ───────── */

async function putDomain(uid: string, id: string, at: string, type = 'draft_created'): Promise<void> {
  await getStorage().set(`${userCol(uid, EVENTS)}/${sortableDocId(at, id)}`, { id, type, at, aggregateId: 'c1', payload: {} });
}

async function putLedger(uid: string, id: string, at: string, type = 'plan_accepted'): Promise<void> {
  await getStorage().set(`${userCol(uid, PLAN_EVENTS)}/${sortableDocId(at, id)}`, {
    id, type, at, date: '2026-09-02', generation: 1, inputDigest: 'x',
  });
}

async function walkSources(uid: string, limit: number): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page += 1) {
    const result = await listActivitySources(uid, { limit, cursor });
    seen.push(...result.events.map((event) => event.id));
    cursor = result.nextCursor;
    if (cursor === null) return seen;
  }
  throw new Error('the walk did not end');
}

test('a page the merge overfills says there is more, even when neither collection does', async () => {
  begin();
  try {
    // Each collection fits in a page of two on its own, so neither reports a
    // next page; only the merged count shows the third record exists.
    await putDomain(OWNER, 'd1', '2026-09-14T09:00:00.000Z');
    await putDomain(OWNER, 'd2', '2026-09-14T08:00:00.000Z');
    await putLedger(OWNER, 'l1', '2026-09-14T07:00:00.000Z');
    assert.deepEqual(await walkSources(OWNER, 2), ['d1', 'd2', 'l1']);
  } finally {
    end();
  }
});

/** Deterministic: the same seed writes the same log on every run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('seeded logs walk in the one total order at every page size', async () => {
  const LEDGER_TYPES = [
    'plan_accepted', 'plan_proposed', 'plan_regenerated', 'plan_dismissed', 'plan_edited',
    'plan_proposal_accepted', 'plan_proposal_rejected',
  ];
  const SHOWN = new Set(Object.keys(ACTIVITY_KIND_BY_PLAN_EVENT_TYPE));
  for (let seed = 1; seed <= 40; seed += 1) {
    begin();
    try {
      const random = seeded(seed);
      // Few distinct instants, so ties across the two collections are common.
      const instants = 1 + Math.floor(random() * 4);
      const expected: Array<{ id: string; at: string }> = [];
      const count = Math.floor(random() * 16);
      for (let index = 0; index < count; index += 1) {
        const at = new Date(Date.parse('2026-09-01T00:00:00.000Z') + Math.floor(random() * instants) * 3_600_000).toISOString();
        const id = `${String(Math.floor(random() * 1e9)).padStart(10, '0')}-${index}`;
        if (random() < 0.5) {
          await putDomain(OWNER, `d${id}`, at);
          expected.push({ id: `d${id}`, at });
        } else {
          const type = LEDGER_TYPES[Math.floor(random() * LEDGER_TYPES.length)]!;
          await putLedger(OWNER, `l${id}`, at, type);
          if (SHOWN.has(type)) expected.push({ id: `l${id}`, at });
        }
      }
      const order = expected
        .map((entry) => ({ ...entry, type: '', aggregateId: '', payload: {} }))
        .sort(compareEventsNewestFirst)
        .map((entry) => entry.id);
      for (const limit of [1, 2, 3, 5, 8]) {
        assert.deepEqual(await walkSources(OWNER, limit), order, `seed ${seed}, page of ${limit}`);
      }
    } finally {
      end();
    }
  }
});

/* ── A wipe takes the ledger with it ─────────────────────────────── */

test('deleting the participant’s data leaves no plan, history or first-plan Moment to resurrect', async () => {
  begin();
  try {
    await setProfile(OWNER, 'ar');
    await seedTask(OWNER, 'c1', '2026-09-14T03:00:00.000Z');
    await buildPlan(OWNER, '2026-09-14', '2026-09-14T04:00:00.000Z');
    await acceptPlan(OWNER, '2026-09-14', { now: () => new Date('2026-09-14T05:00:00.000Z') });
    // A legacy-style entry too, which only the ledger scan would find.
    await appendPlanEvent(OWNER, {
      type: 'plan_accepted', date: '2026-09-10', at: '2026-09-10T05:00:00.000Z', generation: 1, inputDigest: 'legacy',
    });
    await buildPlan(STRANGER, '2026-09-14', '2026-09-14T04:00:00.000Z');
    await acceptPlan(STRANGER, '2026-09-14', { now: () => new Date('2026-09-14T05:00:00.000Z') });

    await deleteParticipantDomainState(OWNER);

    assert.deepEqual(await history(OWNER), []);
    const week = await summary(OWNER, '2026-09-13');
    assert.deepEqual([week.plannedDaysCount, week.moments], [0, []]);
    assert.equal(await getStorage().get(`users/${OWNER}/plans/2026-09-14`), null);
    // Only the requested participant.
    assert.equal((await summary(STRANGER, '2026-09-13')).plannedDaysCount, 1);
  } finally {
    end();
  }
});

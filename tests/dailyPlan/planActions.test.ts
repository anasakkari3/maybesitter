/**
 * What a person may do to their plan, and what they may not (UC-3.10a, #194).
 *
 * The acceptance criterion is the refusal: an invalid edit answers 422 with a
 * reason code **and the stored plan is unchanged**. Both halves are asserted,
 * and the second is asserted by deep-comparing the whole document rather than
 * by checking a status field — a refusal that rewrote the document with the
 * same values and a fresh `updatedAt` would pass the weaker check while having
 * made the plan's own history a lie.
 *
 * The routes are invoked in-process, the way `mobileApiRoutes.test.ts` does, so
 * the status code and the body shape are the ones the React Native client (#195)
 * will actually receive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter } from '../../lib/storage/storageAdapter.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommand as applyDomainCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import {
  buildAndStoreDailyPlan,
  claimDueDelivery,
  savePlanSettings,
} from '../../lib/services/dailyPlan/dailyPlanService.ts';
import { listPlanEvents, readStoredPlan } from '../../lib/services/dailyPlan/planStore.ts';
import { MAX_PLAN_GENERATIONS_PER_DAY, MAX_PLAN_REBUILDS_PER_DAY } from '../../lib/services/dailyPlan/planSettings.ts';
import { effectiveSchedule, regeneratePlan } from '../../lib/services/dailyPlan/planActions.ts';
import { GET as planGet } from '../../src/app/api/mobile/plans/[date]/route.ts';
import { POST as actionsPost } from '../../src/app/api/mobile/plans/[date]/actions/route.ts';
import { POST as regeneratePost } from '../../src/app/api/mobile/plans/[date]/regenerate/route.ts';
import { GET as settingsGet, PUT as settingsPut } from '../../src/app/api/mobile/settings/plan/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('PlanUser');
const DATE = '2026-09-15';
const MORNING = new Date('2026-09-15T06:00:00.000Z');

function request(path: string, options: { method?: string; body?: unknown; uid?: string } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(options.uid ?? USER)}` });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
}

function seedState() {
  let state = createEmptyDomainState();
  const titles = ['Write the summary', 'Call the bank', 'Book the train'];
  for (let index = 0; index < titles.length; index += 1) {
    const id = `cmt_${index}`;
    const title = titles[index]!;
    state = applyDomainCommand(state, {
      type: 'CreateDraft',
      now: '2026-09-14T06:00:00.000Z',
      commitment: { id, kind: 'task', title, timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
      draftStatus: 'pending_confirmation',
    }).newState;
    state = applyDomainCommand(state, {
      type: 'ConfirmCommitment', commitmentId: id, now: '2026-09-14T06:00:00.000Z', reminders: [],
    }).newState;
  }
  return state;
}

interface Harness {
  storage: StorageAdapter;
  auth: FakeAuthControls;
  teardown(): void;
}

async function setup(): Promise<Harness> {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  const auth = installFakeAuth();
  await persistParticipantState(USER, seedState());
  const user = await storage.get<Record<string, unknown>>(userDoc(USER));
  await storage.set(userDoc(USER), { ...(user ?? {}), timezone: TZ, locale: 'en' });
  await savePlanSettings(USER, { enabled: true, deliveryLocalTime: '07:30' }, new Date('2026-09-14T12:00:00.000Z'), { storage });
  const claim = await claimDueDelivery(USER, MORNING, { storage });
  await buildAndStoreDailyPlan(claim!, { storage, now: () => MORNING });
  return {
    storage,
    auth,
    teardown() {
      auth.restore();
      resetStorageForTests();
    },
  };
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await setup();
  try {
    await fn(harness);
  } finally {
    harness.teardown();
  }
}

/* ── Reading it ──────────────────────────────────────────────────── */

test('GET returns the plan with ids joined to titles', async () => {
  await withHarness(async () => {
    const response = await planGet(request(`/api/mobile/plans/${DATE}`), params(DATE));
    assert.equal(response.status, 200);
    const body = await response.json() as { plan: { scheduled: Array<{ itemId: string; title: string | null }>; explanation: { source: string } } };
    assert.equal(body.plan.scheduled.length, 3);
    assert.deepEqual(
      body.plan.scheduled.map((item) => item.title).sort(),
      ['Book the train', 'Call the bank', 'Write the summary'],
    );
    // No model is configured in the suite, so the explanation is the template.
    assert.equal(body.plan.explanation.source, 'template');
  });
});

test('GET answers 404 for a date with no plan, and 400 for a date that is not one', async () => {
  await withHarness(async () => {
    assert.equal((await planGet(request('/api/mobile/plans/2026-09-16'), params('2026-09-16'))).status, 404);
    assert.equal((await planGet(request('/api/mobile/plans/tomorrow'), params('tomorrow'))).status, 400);
    assert.equal((await planGet(request('/api/mobile/plans/2026-02-30'), params('2026-02-30'))).status, 400);
  });
});

test('one account cannot read another account\'s plan', async () => {
  await withHarness(async () => {
    const other = uidFor('OtherUser');
    const response = await planGet(
      request(`/api/mobile/plans/${DATE}`, { uid: other }),
      params(DATE),
    );
    assert.equal(response.status, 404, 'a second account saw a plan built for the first');
  });
});

/* ── Accepting and dismissing ────────────────────────────────────── */

test('accept records the answer and the moment', async () => {
  await withHarness(async ({ storage }) => {
    const response = await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, { body: { action: 'accept' } }), params(DATE));
    assert.equal(response.status, 200);
    const stored = await readStoredPlan(USER, DATE, storage);
    assert.equal(stored!.status, 'accepted');
    assert.ok(stored!.acceptedAt);
    // Sorted: the ledger orders by the caller's `at`, and this harness builds
    // the plan on a fixed 2026 clock while the route runs on the real one.
    assert.deepEqual(
      (await listPlanEvents(USER, storage)).map((event) => event.type).sort(),
      ['plan_accepted', 'plan_proposed'],
    );
  });
});

test('dismiss records the answer without accepting it', async () => {
  await withHarness(async ({ storage }) => {
    assert.equal((await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, { body: { action: 'dismiss' } }), params(DATE))).status, 200);
    const stored = await readStoredPlan(USER, DATE, storage);
    assert.equal(stored!.status, 'dismissed');
    assert.equal(stored!.acceptedAt, null);
  });
});

test('an unknown action is refused', async () => {
  await withHarness(async () => {
    assert.equal((await actionsPost(request(`/api/mobile/plans/${DATE}/actions`, { body: { action: 'explode' } }), params(DATE))).status, 400);
  });
});

/* ── Editing ─────────────────────────────────────────────────────── */

test('a move inside the working window is applied, and the scheduler\'s own plan is kept intact', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const first = before!.plan.scheduled[0]!;
    // 15:00 local on 2026-09-15 (UTC+3) is 12:00Z, inside 09:00-20:00.
    const response = await actionsPost(
      request(`/api/mobile/plans/${DATE}/actions`, {
        body: { action: 'edit', moves: [{ itemId: first.itemId, startsAt: '2026-09-15T12:00:00.000Z' }] },
      }),
      params(DATE),
    );
    assert.equal(response.status, 200);

    const after = await readStoredPlan(USER, DATE, storage);
    assert.equal(after!.status, 'edited');
    assert.deepEqual(after!.plan, before!.plan, 'the scheduler\'s plan was rewritten by a user edit');
    assert.deepEqual(after!.edits.moves, [{
      itemId: first.itemId,
      startsAt: '2026-09-15T12:00:00.000Z',
      endsAt: '2026-09-15T12:30:00.000Z',
    }], 'the move did not keep the length the planner gave the item');

    const shown = effectiveSchedule(after!).find((item) => item.itemId === first.itemId);
    assert.equal(shown!.interval.startsAt, '2026-09-15T12:00:00.000Z');
  });
});

test('a removal takes the item out of what is shown without touching the plan', async () => {
  await withHarness(async ({ storage }) => {
    const before = await readStoredPlan(USER, DATE, storage);
    const removed = before!.plan.scheduled[1]!.itemId;
    assert.equal((await actionsPost(
      request(`/api/mobile/plans/${DATE}/actions`, { body: { action: 'edit', removals: [removed] } }),
      params(DATE),
    )).status, 200);

    const after = await readStoredPlan(USER, DATE, storage);
    assert.deepEqual(after!.plan.scheduled, before!.plan.scheduled);
    assert.equal(effectiveSchedule(after!).some((item) => item.itemId === removed), false);
  });
});

const INVALID: Array<[string, (first: string) => unknown, string]> = [
  ['a move outside the day', (first) => ({ moves: [{ itemId: first, startsAt: '2026-09-20T09:00:00.000Z' }] }), 'outside_horizon'],
  ['a move outside the working hours', (first) => ({ moves: [{ itemId: first, startsAt: '2026-09-15T00:30:00.000Z' }] }), 'outside_working_window'],
  ['a move onto another item in the plan', (first) => ({ moves: [{ itemId: first, startsAt: '__SECOND__' }] }), 'overlaps_scheduled_item'],
  ['an item this plan does not contain', () => ({ moves: [{ itemId: 'cmt_not_here', startsAt: '2026-09-15T12:00:00.000Z' }] }), 'unknown_item'],
  ['a backwards interval', (first) => ({ moves: [{ itemId: first, startsAt: '2026-09-15T12:00:00.000Z', endsAt: '2026-09-15T11:00:00.000Z' }] }), 'invalid_interval'],
  ['a start that is not an instant', (first) => ({ moves: [{ itemId: first, startsAt: 'tomorrow morning' }] }), 'invalid_instant'],
  ['an edit that edits nothing', () => ({}), 'empty_edit'],
];

for (const [label, build, reason] of INVALID) {
  test(`${label} answers 422 with '${reason}' and leaves the stored plan untouched`, async () => {
    await withHarness(async ({ storage }) => {
      const before = await readStoredPlan(USER, DATE, storage);
      const first = before!.plan.scheduled[0]!.itemId;
      const second = before!.plan.scheduled[1]!.interval.startsAt;
      const payload = JSON.parse(JSON.stringify(build(first)).replace('__SECOND__', second)) as Record<string, unknown>;

      const response = await actionsPost(
        request(`/api/mobile/plans/${DATE}/actions`, { body: { action: 'edit', ...payload } }),
        params(DATE),
      );
      assert.equal(response.status, 422, `${label} was not refused`);
      const body = await response.json() as { success: boolean; reason: string; itemId: string | null };
      assert.equal(body.success, false);
      assert.equal(body.reason, reason);

      assert.deepEqual(
        await readStoredPlan(USER, DATE, storage),
        before,
        'a refused edit changed the stored plan',
      );
    });
  });
}

test('a move onto a busy block is refused even though the hour is free', async () => {
  await withHarness(async ({ storage }) => {
    // A blocking fixed event is written into the plan's own constraints, which
    // is exactly what UC-3.2 (#186) will put there for a calendar event.
    const before = await readStoredPlan(USER, DATE, storage);
    const busy = { startsAt: '2026-09-15T13:00:00.000Z', endsAt: '2026-09-15T14:00:00.000Z' };
    await storage.set(`users/${USER}/plans/${DATE}`, {
      ...before!,
      constraints: {
        ...before!.constraints,
        fixedEvents: [
          ...before!.constraints.fixedEvents,
          { eventId: 'busy:b1', interval: busy, sourceCommitmentId: null, blocking: true },
        ],
      },
    });
    const withBusy = await readStoredPlan(USER, DATE, storage);

    const response = await actionsPost(
      request(`/api/mobile/plans/${DATE}/actions`, {
        body: { action: 'edit', moves: [{ itemId: withBusy!.plan.scheduled[0]!.itemId, startsAt: '2026-09-15T13:15:00.000Z' }] },
      }),
      params(DATE),
    );
    assert.equal(response.status, 422);
    assert.equal((await response.json() as { reason: string }).reason, 'overlaps_fixed_event');
    assert.deepEqual(await readStoredPlan(USER, DATE, storage), withBusy);
  });
});

/* ── Regenerating ────────────────────────────────────────────────── */

test('regenerate rebuilds the plan and increments the generation', async () => {
  await withHarness(async ({ storage }) => {
    const response = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { body: {} }), params(DATE));
    assert.equal(response.status, 200);
    const stored = await readStoredPlan(USER, DATE, storage);
    assert.equal(stored!.generation, 2);
    assert.equal(stored!.status, 'proposed');
    assert.deepEqual(
      (await listPlanEvents(USER, storage)).map((event) => event.type).sort(),
      ['plan_proposed', 'plan_regenerated'],
    );
  });
});

test(`a plan can be rebuilt ${MAX_PLAN_REBUILDS_PER_DAY} times a day and then answers 429`, async () => {
  await withHarness(async ({ storage }) => {
    for (let attempt = 1; attempt <= MAX_PLAN_REBUILDS_PER_DAY; attempt += 1) {
      assert.equal((await regeneratePlan(USER, DATE, { storage })).ok, true, `rebuild ${attempt} was refused`);
    }
    const response = await regeneratePost(request(`/api/mobile/plans/${DATE}/regenerate`, { body: {} }), params(DATE));
    assert.equal(response.status, 429);
    const body = await response.json() as { reason: string; error: string };
    assert.equal(body.reason, 'limit_reached');
    // The number in the sentence is the number of rebuilds the loop above got.
    // It said five while allowing four, which is the kind of wrong a user finds
    // by counting.
    assert.equal(
      body.error,
      `a plan can be rebuilt ${MAX_PLAN_REBUILDS_PER_DAY} times a day`,
      'the 429 promises a number of rebuilds the route does not allow',
    );
    assert.equal((await readStoredPlan(USER, DATE, storage))!.generation, MAX_PLAN_GENERATIONS_PER_DAY);
  });
});

test('regenerating a date with no plan answers 404', async () => {
  await withHarness(async () => {
    assert.equal((await regeneratePost(request('/api/mobile/plans/2026-09-16/regenerate', { body: {} }), params('2026-09-16'))).status, 404);
  });
});

/* ── Settings ────────────────────────────────────────────────────── */

test('the settings round-trip, and arming reports when the next plan arrives', async () => {
  await withHarness(async () => {
    const put = await settingsPut(request('/api/mobile/settings/plan', { method: 'PUT', body: { enabled: true, deliveryLocalTime: '06:15' } }));
    assert.equal(put.status, 200);
    const body = await put.json() as { planSettings: { enabled: boolean; deliveryLocalTime: string; timezone: string; nextRunAt: string | null } };
    assert.equal(body.planSettings.deliveryLocalTime, '06:15');
    assert.equal(body.planSettings.timezone, TZ);
    assert.ok(body.planSettings.nextRunAt, 'an armed account was not told when its next plan arrives');

    const get = await settingsGet(request('/api/mobile/settings/plan'));
    assert.deepEqual((await get.json() as { planSettings: unknown }).planSettings, body.planSettings);
  });
});

test('switching delivery off clears the next run', async () => {
  await withHarness(async () => {
    const response = await settingsPut(request('/api/mobile/settings/plan', { method: 'PUT', body: { enabled: false } }));
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { planSettings: { nextRunAt: string | null } }).planSettings.nextRunAt, null);
  });
});

test('a delivery time that is not HH:mm is refused with a reason', async () => {
  await withHarness(async ({ storage }) => {
    // One guarded request first: `requireMobileUser` creates this account's
    // trust record on first sight, and that write is the guard's, not this
    // route's. Snapshotting before it would compare two different things.
    await settingsGet(request('/api/mobile/settings/plan'));
    const before = await storage.get(userDoc(USER));
    for (const value of ['25:00', '7:30', 'morning', '07:60']) {
      const response = await settingsPut(request('/api/mobile/settings/plan', { method: 'PUT', body: { enabled: true, deliveryLocalTime: value } }));
      assert.equal(response.status, 400, `${value} was accepted`);
      assert.equal((await response.json() as { reason: string }).reason, 'invalid_delivery_time');
    }
    assert.deepEqual(await storage.get(userDoc(USER)), before, 'a refused settings change was written anyway');
  });
});

test('enabled must be a boolean', async () => {
  await withHarness(async () => {
    assert.equal((await settingsPut(request('/api/mobile/settings/plan', { method: 'PUT', body: { enabled: 'yes' } }))).status, 400);
  });
});

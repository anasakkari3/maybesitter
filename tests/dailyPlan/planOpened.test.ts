/**
 * "The plan was put on screen" (UC-3.16 follow-up, #533).
 *
 * The route appends a `plan_opened` row to the caller's own plan ledger, and
 * every claim here is checked against that ledger rather than against the
 * response: the generation and digest are the stored plan's own, the row
 * carries no plan content, and a plan that does not exist cannot be opened.
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
import { POST as openedPost } from '../../src/app/api/mobile/plans/[date]/opened/route.ts';

const BASE = 'http://127.0.0.1:4321';
const TZ = 'Asia/Jerusalem';
const USER = uidFor('PlanOpenUser');
const DATE = '2026-09-15';
const MORNING = new Date('2026-09-15T06:00:00.000Z');

function request(path: string, options: { uid?: string | null } = {}): Request {
  const headers = new Headers();
  if (options.uid !== null) headers.set('authorization', `Bearer ${tokenFor(options.uid ?? USER)}`);
  return new Request(`${BASE}${path}`, { method: 'POST', headers });
}

function params(date: string): { params: Promise<{ date: string }> } {
  return { params: Promise.resolve({ date }) };
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
  let state = createEmptyDomainState();
  state = applyDomainCommand(state, {
    type: 'CreateDraft',
    now: '2026-09-14T06:00:00.000Z',
    commitment: { id: 'cmt_0', kind: 'task', title: 'Write the summary', timeSpec: { kind: 'due_by', dueAt: null, remindAt: null, timezone: TZ } },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyDomainCommand(state, {
    type: 'ConfirmCommitment', commitmentId: 'cmt_0', now: '2026-09-14T06:00:00.000Z', reminders: [],
  }).newState;
  await persistParticipantState(USER, state);
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

test('opening a plan appends one ledger row with the plan’s own generation and digest, and no content', async () => {
  const harness = await setup();
  try {
    const stored = await readStoredPlan(USER, DATE);
    assert.ok(stored, 'the harness must build a plan');

    const response = await openedPost(request(`/api/mobile/plans/${DATE}/opened`), params(DATE));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });

    const rows = (await listPlanEvents(USER)).filter((event) => event.type === 'plan_opened');
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.equal(row.date, DATE);
    assert.equal(row.generation, stored.generation);
    assert.equal(row.inputDigest, stored.inputDigest);
    assert.ok(Number.isFinite(Date.parse(row.at)), 'the open carries the instant it happened');
    // The whole record: an id, a type, a date, an instant, a number and a
    // hash. Anything else — above all anything the plan says — fails here.
    assert.deepEqual(Object.keys(row).sort(), ['at', 'date', 'generation', 'id', 'inputDigest', 'type']);
  } finally {
    harness.teardown();
  }
});

test('each open is recorded: two opens of one plan are two rows', async () => {
  const harness = await setup();
  try {
    await openedPost(request(`/api/mobile/plans/${DATE}/opened`), params(DATE));
    await openedPost(request(`/api/mobile/plans/${DATE}/opened`), params(DATE));
    const rows = (await listPlanEvents(USER)).filter((event) => event.type === 'plan_opened');
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0]!.id, rows[1]!.id);
  } finally {
    harness.teardown();
  }
});

test('a plan that does not exist cannot be opened, and a bad date is a 400', async () => {
  const harness = await setup();
  try {
    const missing = await openedPost(request('/api/mobile/plans/2026-09-16/opened'), params('2026-09-16'));
    assert.equal(missing.status, 404);
    const malformed = await openedPost(request('/api/mobile/plans/not-a-date/opened'), params('not-a-date'));
    assert.equal(malformed.status, 400);
    assert.equal((await listPlanEvents(USER)).filter((event) => event.type === 'plan_opened').length, 0);
  } finally {
    harness.teardown();
  }
});

test('nobody unauthenticated records an open, and one account’s open is not another’s', async () => {
  const harness = await setup();
  try {
    const anonymous = await openedPost(request(`/api/mobile/plans/${DATE}/opened`, { uid: null }), params(DATE));
    assert.equal(anonymous.status, 401);
    assert.equal((await listPlanEvents(USER)).filter((event) => event.type === 'plan_opened').length, 0);

    const stranger = uidFor('PlanOpenStranger');
    // The stranger has no plan for the date, so their call is a 404 and the
    // owner's ledger is untouched either way.
    const crossAccount = await openedPost(request(`/api/mobile/plans/${DATE}/opened`, { uid: stranger }), params(DATE));
    assert.equal(crossAccount.status, 404);
    assert.equal((await listPlanEvents(USER)).filter((event) => event.type === 'plan_opened').length, 0);
    assert.equal((await listPlanEvents(stranger)).filter((event) => event.type === 'plan_opened').length, 0);
  } finally {
    harness.teardown();
  }
});

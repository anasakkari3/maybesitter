/**
 * `POST /api/mobile/reminders/receipts` (UC-3.12b, #198).
 *
 * A receipt is what stands the server's backup push down, so the tests here
 * are mostly about when one must *not* be accepted: for a reminder that has
 * moved, for somebody else's commitment, or in a body the server cannot read.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { POST as receiptsPost } from '../../src/app/api/mobile/reminders/receipts/route.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { patchCommitment } from '../../lib/services/mobile/commitmentService.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { hardReminderPath, HARD_LEAD_MS, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import {
  recordHardReceipts,
  resetReceiptReconcileThrottleForTests,
} from '../../lib/services/reminders/hardReceipts.ts';
import { reconcileHardReminderIndex } from '../../lib/services/reminders/hardReminderIndex.ts';
import { mustRingIdentifier } from '../../lib/services/reminders/mustRingIdentifier.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';

const BASE = 'http://127.0.0.1:4321';
const ALICE = uidFor('ReceiptAlice');
const BOB = uidFor('ReceiptBob');
const PHONE = '11111111-1111-4111-8111-111111111111';
const START = Date.now() + 3 * 3_600_000;
const FIRE_AT = new Date(START - HARD_LEAD_MS).toISOString();

let auth: FakeAuthControls | null = null;

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  resetReceiptReconcileThrottleForTests();
  auth = installFakeAuth();
  return () => {
    auth?.restore();
    auth = null;
    resetStorageForTests();
  };
}

function post(body: unknown, uid: string | null = ALICE): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}/api/mobile/reminders/receipts`, { method: 'POST', headers, body: JSON.stringify(body) });
}

function mustFor(start = START): Commitment {
  return {
    id: 'c1', kind: 'task', title: 'Dentist', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: new Date(start).toISOString(), endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), confirmedAt: new Date().toISOString(),
    completedAt: null, droppedAt: null,
  } as Commitment;
}

async function aliceRings(): Promise<void> {
  await saveReminderSettings(ALICE, { hardEnabled: true, escalationCeiling: 'hard' }, new Date().toISOString());
  const state = createEmptyDomainState();
  state.commitments.c1 = mustFor();
  await persistParticipantState(ALICE, state);
}

function body(overrides: Record<string, unknown> = {}, receipt: Record<string, unknown> = {}) {
  return {
    installationId: PHONE,
    receipts: [{ commitmentId: 'c1', notificationId: 'c1:strong', fireAt: FIRE_AT, exact: true, ...receipt }],
    ...overrides,
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

async function aliceRow(): Promise<HardReminderEntry | null> {
  return getStorage().get<HardReminderEntry>(hardReminderPath(ALICE, 'c1'));
}

test('no token is 401, and nothing is written', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    assert.equal((await receiptsPost(post(body(), null))).status, 401);
    assert.equal((await aliceRow())?.localReceipt, undefined);
  } finally {
    teardown();
  }
});

test('a receipt for the reminder as it stands is stored, with ids, a boolean and an instant', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    const response = await receiptsPost(post(body()));
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { success: true, accepted: 1, ignored: 0 });
    const stored = (await aliceRow())?.localReceipt;
    assert.deepEqual(Object.keys(stored ?? {}).sort(), ['exact', 'installationId', 'notificationId', 'scheduledAt']);
    assert.equal(stored?.installationId, PHONE);
    assert.equal(stored?.exact, true);
  } finally {
    teardown();
  }
});

test('a receipt for an instant the reminder no longer has is ignored', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    // The commitment moved an hour later; the phone still reports the old ring.
    await patchCommitment('c1', { dueDate: new Date(START + 3_600_000).toISOString() }, new Date(), { participantId: ALICE });
    const response = await receiptsPost(post(body()));
    assert.deepEqual(await json(response), { success: true, accepted: 0, ignored: 1 });
    assert.equal((await aliceRow())?.localReceipt, undefined);
  } finally {
    teardown();
  }
});

test('one account cannot file a receipt against another account s reminder', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    // Bob posts Alice's commitment id and instant under his own token.
    const response = await receiptsPost(post(body(), BOB));
    assert.deepEqual(await json(response), { success: true, accepted: 0, ignored: 1 });
    assert.equal((await aliceRow())?.localReceipt, undefined);
  } finally {
    teardown();
  }
});

test('a commitment written before the index existed still takes its receipt', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    // As if the row had never been written.
    await getStorage().delete(hardReminderPath(ALICE, 'c1'));
    const response = await receiptsPost(post(body()));
    assert.deepEqual(await json(response), { success: true, accepted: 1, ignored: 0 });
  } finally {
    teardown();
  }
});

test('a body the server cannot read is refused whole, with the reason', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    const cases: Array<[unknown, string]> = [
      [[], 'invalid_body'],
      [body({ installationId: 'not-a-uuid' }), 'invalid_installation_id'],
      [body({ receipts: 'x' }), 'invalid_receipts'],
      [body({ extra: 1 }), 'unknown_field'],
      [body({}, { title: 'Dentist' }), 'unknown_field'],
      [body({}, { notificationId: 'c1:soft' }), 'invalid_notification_id'],
      [body({}, { fireAt: 'soon' }), 'invalid_fire_at'],
      [body({}, { exact: 'true' }), 'invalid_exact'],
      [body({}, { commitmentId: '' }), 'invalid_commitment_id'],
      [body({ receipts: Array.from({ length: 51 }, () => body().receipts[0]) }), 'too_many_receipts'],
    ];
    for (const [input, reason] of cases) {
      const response = await receiptsPost(post(input));
      assert.equal(response.status, 400, `accepted ${JSON.stringify(input).slice(0, 80)}`);
      assert.equal((await json(response)).reason, reason);
    }
    assert.equal((await aliceRow())?.localReceipt, undefined);
  } finally {
    teardown();
  }
});

test('F4: a receipt upload reconciles only for a missing row, and at most once per five minutes', async () => {
  const teardown = setup();
  try {
    await aliceRings();
    let calls = 0;
    const reconcile: typeof reconcileHardReminderIndex = async (...args) => {
      calls += 1;
      return reconcileHardReminderIndex(...args);
    };
    const upload = { installationId: PHONE, receipts: body().receipts as never };
    const now = new Date();

    await recordHardReceipts(ALICE, upload, now, { reconcile });
    assert.equal(calls, 0, 'reconciled although the row was there');

    await getStorage().delete(hardReminderPath(ALICE, 'c1'));
    assert.equal((await recordHardReceipts(ALICE, upload, now, { reconcile })).accepted, 1);
    assert.equal(calls, 1);

    await getStorage().delete(hardReminderPath(ALICE, 'c1'));
    await recordHardReceipts(ALICE, upload, new Date(now.getTime() + 60_000), { reconcile });
    assert.equal(calls, 1, 'reconciled twice inside five minutes');

    await recordHardReceipts(ALICE, upload, new Date(now.getTime() + 6 * 60_000), { reconcile });
    assert.equal(calls, 2);
  } finally {
    teardown();
  }
});

test('F2: the receipt for a long id names the bounded identifier, and nothing else', async () => {
  const teardown = setup();
  try {
    const id = 'y'.repeat(128);
    const response = await receiptsPost(post({ installationId: PHONE, receipts: [{ commitmentId: id, notificationId: `${id}:strong`, fireAt: FIRE_AT, exact: true }] }));
    assert.equal((await json(response)).reason, 'invalid_notification_id');
    const ok = await receiptsPost(post({ installationId: PHONE, receipts: [{ commitmentId: id, notificationId: mustRingIdentifier(id), fireAt: FIRE_AT, exact: true }] }));
    assert.equal(ok.status, 200);
  } finally {
    teardown();
  }
});

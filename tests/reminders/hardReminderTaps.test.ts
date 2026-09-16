/**
 * A notification tap stands the server's Must backup down (#200 × #198).
 *
 * #198's criterion: "completing, postponing, cancelling or acknowledging before
 * `fireAt` → no push". Each case goes through `applyCommitmentAction` with a
 * `clientActionId` — the path the phone's outbox uses — and then the real job
 * ticks at and after `fireAt`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { applyCommitmentAction } from '../../lib/services/mobile/commitmentService.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import type { FcmMessage, MessagingClient } from '../../lib/push/pushService.ts';
import { hardReminderPath, HARD_LEAD_MS, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { runHardReminderTick } from '../../lib/services/reminders/hardReminderJob.ts';

const USER = 'hardTapUser';
const PHONE = '11111111-1111-4111-8111-111111111111';
const TODAY = new Date();
const NOW = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + 1, 6));
const START = NOW.getTime() + 2 * 3_600_000;
const FIRE_AT = START - HARD_LEAD_MS;
const ID = '3f0e8a52-7c1b-4d2e-9a61-0b5c7d9e1f24';

function mustCommitment(id: string): Commitment {
  return {
    id, kind: 'task', title: 'Dentist', description: null, person: null, status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
    category: null, categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: new Date(START).toISOString(), endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), confirmedAt: NOW.toISOString(),
    completedAt: null, droppedAt: null,
  } as Commitment;
}

async function world(id = 'c1'): Promise<void> {
  setStorageForTests(createMemoryStorage());
  await saveReminderSettings(USER, { hardEnabled: true, escalationCeiling: 'hard' }, NOW.toISOString());
  await upsertDevice(USER, {
    installationId: PHONE, fcmToken: `token-${PHONE}-abcdefghijklmnopqrstuvwxyz`, platform: 'android',
    appVersion: '1.0.0', locale: 'ar', timezone: 'UTC', pushPermission: 'granted',
  }, NOW.toISOString());
  const state = createEmptyDomainState();
  state.commitments[id] = mustCommitment(id);
  await persistParticipantState(USER, state);
}

function fakeMessaging(): MessagingClient & { sent: FcmMessage[] } {
  const sent: FcmMessage[] = [];
  return { sent, async send(message: FcmMessage) { sent.push(message); return `m/${sent.length}`; } };
}

async function ticks(id = 'c1') {
  const messaging = fakeMessaging();
  for (const minutes of [0, 3, 5]) {
    await runHardReminderTick({ now: () => new Date(FIRE_AT + minutes * 60_000), storage: getStorage(), messaging });
  }
  const row = await getStorage().get<HardReminderEntry>(hardReminderPath(USER, id));
  return { sent: messaging.sent, row };
}

const tap = (id: string, action: 'complete' | 'cancel' | 'aware' | 'postpone', postponedUntil?: string) =>
  applyCommitmentAction(id, action, { participantId: USER, clientActionId: ID, now: NOW, ...(postponedUntil ? { postponedUntil } : {}) });

test('control: with no tap the backup is sent at fireAt', async () => {
  try {
    await world();
    assert.equal((await ticks()).sent.length, 1);
  } finally {
    resetStorageForTests();
  }
});

test('aware (a tap on the reminder) before fireAt: no push, and the row says acknowledged', async () => {
  try {
    await world();
    await tap('c1', 'aware');
    const { sent, row } = await ticks();
    assert.deepEqual(sent, []);
    assert.equal(row?.status, 'suppressed');
    assert.equal(row?.reason, 'acknowledged');
  } finally {
    resetStorageForTests();
  }
});

test('aware replayed by the outbox is still one acknowledgement and still no push', async () => {
  try {
    await world();
    await tap('c1', 'aware');
    const replay = await tap('c1', 'aware');
    assert.equal(replay.replayed, true);
    assert.deepEqual((await ticks()).sent, []);
  } finally {
    resetStorageForTests();
  }
});

test('Done and Not doing it before fireAt: the row is gone and nothing is pushed', async () => {
  for (const action of ['complete', 'cancel'] as const) {
    try {
      await world();
      assert.ok(await getStorage().get(hardReminderPath(USER, 'c1')), 'no row to begin with; this proves nothing');
      await tap('c1', action);
      const { sent, row } = await ticks();
      assert.deepEqual(sent, [], `${action} still pushed`);
      assert.equal(row, null);
    } finally {
      resetStorageForTests();
    }
  }
});

test('Later past fireAt: the council rule stands the backup down', async () => {
  try {
    await world();
    await tap('c1', 'postpone', new Date(FIRE_AT + 60 * 60_000).toISOString());
    assert.deepEqual((await ticks()).sent, []);
  } finally {
    resetStorageForTests();
  }
});

test('a 128-character commitment id is acknowledged too', async () => {
  const id = 'x'.repeat(128);
  try {
    await world(id);
    await tap(id, 'aware');
    const { sent, row } = await ticks(id);
    assert.deepEqual(sent, []);
    assert.equal(row?.reason, 'acknowledged');
  } finally {
    resetStorageForTests();
  }
});

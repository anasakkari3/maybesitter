/**
 * Two backup-job instances racing over one Must reminder, on real Firestore
 * (UC-3.12b, #198).
 *
 * The memory adapter models transaction contention; Firestore is what Cloud Run
 * actually runs against, with optimistic transactions that retry on the
 * server's say-so. Each invocation gets its own client handle, as two Cloud Run
 * instances would.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import type { FcmMessage, MessagingClient } from '../../lib/push/pushService.ts';
import { hardReminderPath, HARD_LEAD_MS, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { runHardReminderTick } from '../../lib/services/reminders/hardReminderJob.ts';

test('firestore: four job instances at once send one Must-reminder backup', async () => {
  const uid = `hardrace_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const writer = createFirestoreStorage();
  setStorageForTests(writer);
  try {
    const now = new Date();
    const start = now.getTime() + HARD_LEAD_MS;
    await saveReminderSettings(uid, { hardEnabled: true, escalationCeiling: 'hard' }, now.toISOString(), { storage: writer });
    await upsertDevice(uid, {
      installationId: '11111111-1111-4111-8111-111111111111',
      fcmToken: `token-${uid}-abcdefghijklmnopqrstuvwxyz0123`,
      platform: 'android', appVersion: '1.0.0', locale: 'en', timezone: 'UTC', pushPermission: 'granted',
    }, now.toISOString(), { storage: writer });
    const state = createEmptyDomainState();
    state.commitments.c1 = {
      id: 'c1', kind: 'task', title: 'x', description: null, person: null, status: 'active',
      priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
      category: null, categorySource: 'inferred',
      timeSpec: { kind: 'scheduled_event', dueAt: new Date(start).toISOString(), endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
      currentAckState: 'not_seen', postponedUntil: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), confirmedAt: now.toISOString(), completedAt: null, droppedAt: null,
    } as Commitment;
    await persistParticipantState(uid, state);
    assert.equal((await writer.get<HardReminderEntry>(hardReminderPath(uid, 'c1')))?.status, 'pending');

    const sent: FcmMessage[] = [];
    const messaging: MessagingClient = {
      async send(message) {
        sent.push(message);
        return 'id';
      },
    };
    await Promise.all([0, 1, 2, 3].map(() => runHardReminderTick({
      now: () => new Date(start - HARD_LEAD_MS),
      storage: createFirestoreStorage(),
      messaging,
    })));

    // Other tests' rows share the collection group; count only this account's.
    assert.equal(sent.filter((message) => message.token.includes(uid)).length, 1);
    assert.equal((await writer.get<HardReminderEntry>(hardReminderPath(uid, 'c1')))?.status, 'sent');
  } finally {
    resetStorageForTests();
  }
});

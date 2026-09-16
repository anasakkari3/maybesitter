/**
 * A notification tap delivered twice at once, against real Firestore (UC-3.14, #200).
 *
 * The memory adapter serialises transactions in one process, so the racing
 * case in `commitmentActionsIdempotency.test.ts` cannot fail there for the
 * reason it would fail in production: two Cloud Run instances each reading
 * "no receipt" and each writing an event. Here the transaction is the
 * database's, and each delivery goes through its own adapter instance.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { applyParticipantCommandOnce, applyParticipantCommands } from '../../lib/services/mobile/participantState.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { hardReminderPath, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { COMMITMENT_ACTION_RECEIPTS, EVENTS, userCol } from '../../lib/storage/paths.ts';

function uniqueUid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

test('firestore: two racing deliveries of one clientActionId write one domain event and one receipt', async () => {
  const uid = uniqueUid('tap_race');
  const clientActionId = '3f0e8a52-7c1b-4d2e-9a61-0b5c7d9e1f24';
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  try {
    const now = new Date().toISOString();
    await applyParticipantCommands(uid, [
      {
        type: 'CreateDraft', now,
        commitment: {
          id: 'c1', kind: 'task', title: 'Call the clinic',
          timeSpec: { kind: 'due_by', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
        },
      },
      { type: 'ConfirmCommitment', commitmentId: 'c1', now },
    ]);

    const deliver = () => applyParticipantCommandOnce(
      uid, clientActionId, 'complete|', { type: 'Complete', commitmentId: 'c1', now: new Date().toISOString() },
    );
    const outcomes = await Promise.all([deliver(), deliver(), deliver()]);
    assert.equal(outcomes.filter((outcome) => outcome.result === 'applied').length, 1, JSON.stringify(outcomes.map((o) => o.result)));

    const reader = createFirestoreStorage();
    const events = await reader.list<{ type: string }>(userCol(uid, EVENTS));
    assert.equal(events.filter((event) => event.data.type === 'commitment_completed').length, 1);
    assert.equal((await reader.list(userCol(uid, COMMITMENT_ACTION_RECEIPTS))).length, 1);

    await saveReminderSettings(uid, { hardEnabled: true, escalationCeiling: 'hard' }, now);
    // aware reads the Must index row inside the transaction (#198); Firestore
    // refuses a read after a write, which memory does not.
    await applyParticipantCommands(uid, [
      {
        type: 'CreateDraft', now,
        commitment: {
          id: 'c2', kind: 'task', title: 'Dentist', priority: { level: 'high' },
          timeSpec: { kind: 'due_by', dueAt: new Date(Date.now() + 3 * 3_600_000).toISOString(), timezone: 'UTC' },
        },
      },
      { type: 'ConfirmCommitment', commitmentId: 'c2', now },
    ]);
    const aware = await applyParticipantCommandOnce(
      uid, '8b2d4c61-1e3f-4a5b-8c7d-9e0f1a2b3c4d', 'aware|',
      { type: 'MarkAware', commitmentId: 'c2', now: new Date().toISOString(), source: 'reminder' },
    );
    assert.equal(aware.result, 'applied');
    const acknowledged = await reader.list<{ type: string }>(userCol(uid, EVENTS));
    assert.equal(acknowledged.filter((event) => event.data.type === 'reminder_acknowledged').length, 1);
    const row = await reader.get<HardReminderEntry>(hardReminderPath(uid, 'c2'));
    assert.equal(row?.status, 'suppressed', 'the Must backup was not stood down on Firestore');
    assert.equal(row?.reason, 'acknowledged');
  } finally {
    await storage.deleteTree(`users/${uid}`);
    resetStorageForTests();
  }
});

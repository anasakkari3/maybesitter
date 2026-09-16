/**
 * The Must reminder's server backup (UC-3.12b, #198).
 *
 * Commitments are written through the product's own write path, so the index
 * rows these tests act on are the ones production would have. The messaging
 * client is a fake that records every FCM message; "no push" is asserted as an
 * empty list, not as a status.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import { persistParticipantState } from '../../lib/services/mobile/participantState.ts';
import {
  completeCommitment,
  dropCommitment,
  patchCommitment,
} from '../../lib/services/mobile/commitmentService.ts';
import { saveReminderSettings } from '../../lib/services/mobile/reminderSettingsService.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { mustRingIdentifier } from '../../lib/services/reminders/mustRingIdentifier.ts';
import { upsertDevice, deleteDevice } from '../../lib/push/deviceRegistry.ts';
import { PUSH_DATA_KEYS, sendToUser, type FcmMessage, type MessagingClient } from '../../lib/push/pushService.ts';
import { hardReminderPath, HARD_LEAD_MS, type HardReminderEntry } from '../../lib/services/reminders/hardReminderIndex.ts';
import { recordHardReceipts } from '../../lib/services/reminders/hardReceipts.ts';
import {
  HARD_REMINDER_COPY,
  INEXACT_GRACE_MS,
  decideHardReminder,
  runHardReminderTick,
} from '../../lib/services/reminders/hardReminderJob.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const USER = 'hardJobUser';
const PHONE_A = '11111111-1111-4111-8111-111111111111';
const PHONE_B = '22222222-2222-4222-8222-222222222222';
/**
 * 06:00 UTC tomorrow, from the real clock. Not a literal: the index is written
 * from `writeDomainDiff`, which stamps the real time, and a reminder more than
 * five minutes in its past is not indexed at all — so a literal date would make
 * this file fail on every day after the one it was written.
 */
const TODAY = new Date();
const NOW = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate() + 1, 6));
const START = NOW.getTime() + 2 * 3_600_000;
const FIRE_AT = START - HARD_LEAD_MS;
const at = (offsetMs: number) => new Date(FIRE_AT + offsetMs);
const TITLE = 'طبيب الأسنان — Dentist';

interface Fake extends MessagingClient {
  sent: FcmMessage[];
}

function fakeMessaging(): Fake {
  const sent: FcmMessage[] = [];
  return {
    sent,
    async send(message: FcmMessage) {
      sent.push(message);
      return `projects/x/messages/${sent.length}`;
    },
  };
}

function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  return () => resetStorageForTests();
}

function mustCommitment(overrides: Partial<Commitment> = {}): Commitment {
  return {
    id: 'c1',
    kind: 'task',
    title: TITLE,
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: true, pressureLevel: 'none' },
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'scheduled_event', dueAt: new Date(START).toISOString(), endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    confirmedAt: NOW.toISOString(),
    completedAt: null,
    droppedAt: null,
    ...overrides,
  } as Commitment;
}

async function world(options: { settings?: Record<string, unknown>; phones?: string[]; commitment?: Commitment } = {}) {
  await saveReminderSettings(USER, { hardEnabled: true, escalationCeiling: 'hard', ...options.settings }, NOW.toISOString());
  for (const installationId of options.phones ?? [PHONE_A]) {
    await upsertDevice(USER, {
      installationId,
      fcmToken: `token-${installationId}-abcdefghijklmnopqrstuvwxyz`,
      platform: 'android',
      appVersion: '1.0.0',
      locale: 'ar',
      timezone: 'UTC',
      pushPermission: 'granted',
    }, NOW.toISOString());
  }
  const state = createEmptyDomainState();
  const item = options.commitment ?? mustCommitment();
  state.commitments[item.id] = item;
  await persistParticipantState(USER, state);
}

async function receipt(installationId: string, exact: boolean): Promise<void> {
  const result = await recordHardReceipts(USER, {
    installationId,
    receipts: [{ commitmentId: 'c1', notificationId: 'c1:strong', fireAt: new Date(FIRE_AT).toISOString(), exact }],
  }, NOW);
  assert.equal(result.accepted, 1, 'the receipt did not land, so this test would prove nothing');
}

async function tick(messaging: Fake, when: Date) {
  return runHardReminderTick({ now: () => when, storage: getStorage(), messaging });
}

async function row(): Promise<HardReminderEntry | null> {
  return getStorage().get<HardReminderEntry>(hardReminderPath(USER, 'c1'));
}

// ── The receipt matrix ───────────────────────────────────────────

test('an exact receipt: zero pushes at fireAt, and the row says why', async () => {
  const teardown = setup();
  try {
    await world();
    await receipt(PHONE_A, true);
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    await tick(messaging, at(INEXACT_GRACE_MS + 60_000));
    assert.deepEqual(messaging.sent, []);
    assert.equal((await row())?.status, 'suppressed');
    assert.equal((await row())?.reason, 'local_receipt');
  } finally {
    teardown();
  }
});

test('no receipt: exactly one push at fireAt, and never another', async () => {
  const teardown = setup();
  try {
    await world();
    const messaging = fakeMessaging();
    await tick(messaging, at(-2 * 60_000));
    assert.equal(messaging.sent.length, 0, 'sent before it was due');
    await tick(messaging, at(0));
    assert.equal(messaging.sent.length, 1);
    // One stage: no repeat, no follow-up, nothing for having been ignored.
    for (const minutes of [1, 2, 3, 4, 5, 30, 600]) await tick(messaging, at(minutes * 60_000));
    assert.equal(messaging.sent.length, 1);
    assert.equal((await row())?.status, 'sent');
  } finally {
    teardown();
  }
});

test('an inexact receipt: nothing until fireAt + 3 min, then one push', async () => {
  const teardown = setup();
  try {
    await world();
    await receipt(PHONE_A, false);
    const messaging = fakeMessaging();
    for (const minutes of [0, 1, 2]) await tick(messaging, at(minutes * 60_000));
    assert.equal(messaging.sent.length, 0);
    await tick(messaging, at(INEXACT_GRACE_MS));
    assert.equal(messaging.sent.length, 1);
    await tick(messaging, at(INEXACT_GRACE_MS + 60_000));
    assert.equal(messaging.sent.length, 1);
  } finally {
    teardown();
  }
});

test('a receipt from a phone that has since signed out does not silence the backup', async () => {
  const teardown = setup();
  try {
    await world({ phones: [PHONE_A, PHONE_B] });
    await receipt(PHONE_A, true);
    await deleteDevice(USER, PHONE_A);
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    assert.equal(messaging.sent.length, 1);
  } finally {
    teardown();
  }
});

test('a receipt from a phone that has since denied notifications does not silence the backup', async () => {
  const teardown = setup();
  try {
    await world({ phones: [PHONE_A, PHONE_B] });
    await receipt(PHONE_A, true);
    // Same phone, same row, permission revoked in system settings.
    await upsertDevice(USER, {
      installationId: PHONE_A,
      fcmToken: `token-${PHONE_A}-abcdefghijklmnopqrstuvwxyz`,
      platform: 'android',
      appVersion: '1.0.0',
      locale: 'ar',
      timezone: 'UTC',
      pushPermission: 'denied',
    }, NOW.toISOString());
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    assert.equal(messaging.sent.length, 1);
  } finally {
    teardown();
  }
});

test('another phone s inexact receipt does not reopen a backup an exact one closed', async () => {
  const teardown = setup();
  try {
    await world({ phones: [PHONE_A, PHONE_B] });
    await receipt(PHONE_A, true);
    const late = await recordHardReceipts(USER, {
      installationId: PHONE_B,
      receipts: [{ commitmentId: 'c1', notificationId: 'c1:strong', fireAt: new Date(FIRE_AT).toISOString(), exact: false }],
    }, NOW);
    assert.equal(late.ignored, 1);
    const messaging = fakeMessaging();
    await tick(messaging, at(INEXACT_GRACE_MS));
    assert.deepEqual(messaging.sent, []);
  } finally {
    teardown();
  }
});

// ── Exactly once, whatever runs at the same time ─────────────────

test('two job invocations at once send one push', async () => {
  const teardown = setup();
  try {
    await world();
    const messaging = fakeMessaging();
    await Promise.all([tick(messaging, at(0)), tick(messaging, at(0)), tick(messaging, at(0))]);
    assert.equal(messaging.sent.length, 1);
  } finally {
    teardown();
  }
});

test('layer 1 on its own: the row is marked sent before the push, so racing invocations cannot both send', async () => {
  const teardown = setup();
  try {
    await world();
    // A send with no lock of its own, so only the row's claim stands between
    // two invocations and a second push.
    let sends = 0;
    const unlocked: typeof sendToUser = async () => {
      sends += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { status: 'sent', delivered: 1, removed: 0 };
    };
    await Promise.all([0, 1, 2].map(() => runHardReminderTick({ now: () => at(0), storage: getStorage(), send: unlocked })));
    assert.equal(sends, 1);
  } finally {
    teardown();
  }
});

test('layer 2 on its own: a row put back to pending is still not pushed twice', async () => {
  const teardown = setup();
  try {
    await world();
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    assert.equal(messaging.sent.length, 1);
    // A restored backup, a hand edit, a bug: the row's claim is gone. The push
    // service's lock on the (commitment, fireAt) key is what remains.
    await getStorage().set(hardReminderPath(USER, 'c1'), { ...(await row() as HardReminderEntry), status: 'pending' });
    await tick(messaging, at(60_000));
    assert.equal(messaging.sent.length, 1);
  } finally {
    teardown();
  }
});

// ── The reminder going away (F3 from the #430 review) ────────────

test('a receipt the server accepted never becomes a push once the Must reminder is gone', async () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['completed', () => completeCommitment('c1', NOW, { participantId: USER })],
    ['cancelled', () => dropCommitment('c1', NOW, { participantId: USER })],
    ['downgraded to Should', () => patchCommitment('c1', { priority: 'normal' }, NOW, { participantId: USER })],
    ['ceiling lowered', () => saveReminderSettings(USER, { escalationCeiling: 'followUp', hardEnabled: false }, NOW.toISOString())],
    ['opt-in turned off', () => saveReminderSettings(USER, { hardEnabled: false }, NOW.toISOString())],
  ];
  for (const exact of [true, false]) {
    for (const [name, act] of cases) {
      const teardown = setup();
      try {
        await world();
        await receipt(PHONE_A, exact);
        await act();
        const messaging = fakeMessaging();
        for (const minutes of [0, 3, 5]) await tick(messaging, at(minutes * 60_000));
        assert.deepEqual(messaging.sent, [], `${name} (exact: ${exact}) still pushed`);
      } finally {
        teardown();
      }
    }
  }
});

test('the ceiling is rechecked at send time, even if the index has not caught up', async () => {
  const teardown = setup();
  try {
    await world();
    // Lowered by a write that did not reconcile the index.
    await getStorage().runTransaction(async (tx) => {
      const user = await tx.get<Record<string, Record<string, unknown>>>(userDoc(USER));
      tx.merge(userDoc(USER), { reminderSettings: { ...user?.reminderSettings, escalationCeiling: 'followUp' } });
    });
    assert.equal((await row())?.status, 'pending');
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    assert.deepEqual(messaging.sent, []);
    assert.equal((await row())?.status, 'cancelled');
    assert.equal((await row())?.reason, 'ceiling');
  } finally {
    teardown();
  }
});

test('moving the start re-arms at the new instant and the stale receipt does not count', async () => {
  const teardown = setup();
  try {
    await world();
    await receipt(PHONE_A, true);
    const moved = START + 60 * 60_000;
    await patchCommitment('c1', { dueDate: new Date(moved).toISOString() }, NOW, { participantId: USER });
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    assert.deepEqual(messaging.sent, [], 'pushed at the old instant');
    await tick(messaging, new Date(moved - HARD_LEAD_MS));
    assert.equal(messaging.sent.length, 1);
  } finally {
    teardown();
  }
});

// ── Quiet hours ──────────────────────────────────────────────────

async function quietAroundFireAt(): Promise<void> {
  // UTC 07:00–09:00 contains fireAt (07:50Z).
  await saveRoutineProfile(USER, {
    timezone: 'UTC',
    sleepWindow: null,
    focusWindows: [],
    fixedCommitmentWindows: [],
    preferredReminderIntensity: 'softAwareness',
    quietHours: { start: '07:00', end: '09:00' },
    surveySkipped: false,
  }, NOW.toISOString());
}

test('inside quiet hours: suppressed without mustThroughQuietHours, sent with it', async () => {
  for (const through of [false, true]) {
    const teardown = setup();
    try {
      await quietAroundFireAt();
      await world({ settings: { mustThroughQuietHours: through } });
      const messaging = fakeMessaging();
      await tick(messaging, at(0));
      await tick(messaging, at(60_000));
      assert.equal(messaging.sent.length, through ? 1 : 0, `mustThroughQuietHours: ${through}`);
      if (!through) assert.equal((await row())?.reason, 'quiet_hours');
    } finally {
      teardown();
    }
  }
});

// ── What the push says ───────────────────────────────────────────

test('the push carries ids only, generic text, and the local ring s identity', async () => {
  const teardown = setup();
  try {
    await world();
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    const [fcm] = messaging.sent;
    assert.ok(fcm);
    for (const key of Object.keys(fcm.data)) assert.ok(PUSH_DATA_KEYS.includes(key), `data.${key}`);
    assert.deepEqual(fcm.data, { kind: 'hard_reminder', commitmentId: 'c1', notificationId: 'c1:strong', tag: 'c1:strong' });
    const everything = JSON.stringify(fcm);
    assert.ok(!everything.includes('Dentist') && !everything.includes('طبيب'), 'commitment text in the push');
    assert.equal(fcm.notification.title, HARD_REMINDER_COPY.ar.title);
    // Shown under the local ring's identifier, so one replaces the other.
    assert.equal(fcm.apns.headers['apns-collapse-id'], 'c1:strong');
    assert.equal(fcm.android.notification.tag, 'c1:strong');
    assert.equal(fcm.android.notification.channelId, 'maybesitter_hard');
    assert.equal(fcm.apns.payload.aps['interruption-level'], 'time-sensitive');
    assert.equal(fcm.apns.payload.aps.sound, 'maybesitter_hard.wav');
    assert.equal(fcm.apns.payload.aps.category, 'com.maybesitter.notification.category.hard');
  } finally {
    teardown();
  }
});

test('the server s copy is the app s copy, in every language', () => {
  for (const locale of ['ar', 'he', 'en'] as const) {
    const bundle = JSON.parse(readFileSync(join(repoRoot, `mobile/src/i18n/locales/${locale}.json`), 'utf8')) as Record<string, string>;
    assert.equal(HARD_REMINDER_COPY[locale].title, bundle.notifHardTitle, `${locale} title`);
    assert.equal(HARD_REMINDER_COPY[locale].body, bundle.notifHardBody, `${locale} body`);
  }
});

test('a Should or a Nice is never pushed', async () => {
  for (const level of ['normal', 'low'] as const) {
    const teardown = setup();
    try {
      await world({ commitment: mustCommitment({ priority: { level, source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } }) });
      const messaging = fakeMessaging();
      await tick(messaging, at(0));
      assert.deepEqual(messaging.sent, []);
    } finally {
      teardown();
    }
  }
});

test('a row that is not pending is never decided again', () => {
  for (const status of ['sent', 'suppressed', 'cancelled'] as const) {
    const decision = decideHardReminder({
      entry: { commitmentId: 'c1', fireAt: new Date(FIRE_AT).toISOString(), startFingerprint: '', status, updatedAt: '', expiresAt: '' },
      commitment: mustCommitment(),
      settings: { hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: false, softEnabled: true, surveySaysNone: false },
      receiptDevice: null,
      now: at(0),
    });
    assert.deepEqual(decision, { kind: 'skip' });
  }
});

// ── Review of #447 ───────────────────────────────────────────────

test('B1: reminders switched off, or a survey answer of none, gets no row and no push', async () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['the master switch off', () => saveReminderSettings(USER, { softEnabled: false }, NOW.toISOString())],
    ['survey none', async () => {
      await saveRoutineProfile(USER, {
        timezone: 'UTC', sleepWindow: null, focusWindows: [], fixedCommitmentWindows: [],
        preferredReminderIntensity: 'none', quietHours: null, surveySkipped: false,
      }, NOW.toISOString());
      // The survey save does not reconcile; the job's recheck is what must hold.
    }],
  ];
  for (const [name, act] of cases) {
    const teardown = setup();
    try {
      await world();
      await act();
      const messaging = fakeMessaging();
      for (const minutes of [0, 1, 4]) await tick(messaging, at(minutes * 60_000));
      assert.deepEqual(messaging.sent, [], `${name} still pushed`);
    } finally {
      teardown();
    }
  }
});

test('B1: switching reminders off removes the row the moment it is saved', async () => {
  const teardown = setup();
  try {
    await world();
    assert.notEqual(await row(), null);
    await saveReminderSettings(USER, { softEnabled: false }, NOW.toISOString());
    assert.equal(await row(), null);
  } finally {
    teardown();
  }
});

test('F1: never sent before fireAt, not even within the minute', async () => {
  const teardown = setup();
  try {
    await world();
    const messaging = fakeMessaging();
    await tick(messaging, at(-30_000));
    await tick(messaging, at(-1));
    assert.deepEqual(messaging.sent, []);
    await tick(messaging, at(0));
    assert.equal(messaging.sent.length, 1);
    // And the decision says so without the query's help.
    for (const early of [-30_000, -1]) {
      assert.deepEqual(decideHardReminder({
        entry: { commitmentId: 'c1', fireAt: new Date(FIRE_AT).toISOString(), startFingerprint: '', status: 'pending', updatedAt: '', expiresAt: '' },
        commitment: mustCommitment(),
        settings: { hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: false, softEnabled: true, surveySaysNone: false },
        receiptDevice: null,
        now: at(early),
      }), { kind: 'wait' });
    }
  } finally {
    teardown();
  }
});

test('F5: a job that reaches a reminder more than five minutes late sends nothing', async () => {
  const teardown = setup();
  try {
    await world();
    const messaging = fakeMessaging();
    await tick(messaging, at(6 * 60_000));
    assert.deepEqual(messaging.sent, []);
    // And the decision says so without the query's help.
    const decision = decideHardReminder({
      entry: (await row()) as HardReminderEntry,
      commitment: mustCommitment(),
      settings: { hardEnabled: true, escalationCeiling: 'hard', mustThroughQuietHours: false, softEnabled: true, surveySaysNone: false },
      receiptDevice: null,
      now: at(6 * 60_000),
    });
    assert.deepEqual(decision, { kind: 'suppress', reason: 'too_late' });
  } finally {
    teardown();
  }
});

test('F2: a 128-character commitment id still gets its backup, under a bounded identifier', async () => {
  const teardown = setup();
  try {
    const id = 'x'.repeat(128);
    await world({ commitment: mustCommitment({ id }) });
    const messaging = fakeMessaging();
    await tick(messaging, at(0));
    assert.equal(messaging.sent.length, 1, 'no backup for a long id');
    const [fcm] = messaging.sent;
    const identifier = mustRingIdentifier(id);
    assert.ok(identifier.length <= 64);
    assert.equal(fcm!.apns.headers['apns-collapse-id'], identifier);
    assert.equal(fcm!.android.notification.tag, identifier);
    assert.equal(fcm!.data.tag, identifier);
  } finally {
    teardown();
  }
});

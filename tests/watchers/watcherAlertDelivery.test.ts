/**
 * A `notify` watcher reaches the phone (QA audit de7fcb8, CA6.1).
 *
 * The audit's chain: a readiness watch with «نبّهني» fired, the sweep wrote
 * `watcherNotifications/*` with `state: "queued"`, and nothing ever read it —
 * no push, no banner. The break was between the queued document and the push
 * service. These tests drive the scheduled tick the deployment runs
 * (`runWatcherTick`) end to end over the in-memory adapter, with a fake FCM
 * client in place of Google's, and hold:
 *
 *   - a firing with `notify` sends one push to the account's devices;
 *   - the push carries identifiers only — no watcher, signal or user text;
 *   - the queued notification records that it was sent;
 *   - effects other than `notify` push nothing;
 *   - quiet hours and a missing device leave the notification queued.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { docIdForKey, PUSH_LOG, userCol, userDoc, userSubDoc, WATCHER_EVENTS, WATCHER_NOTIFICATIONS } from '../../lib/storage/paths.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { saveRoutineProfile } from '../../lib/services/mobile/routineProfileService.ts';
import { deliverWatcherAlert, redriveQueuedWatcherAlerts, watcherAlertDedupeKey, WATCHER_ALERT_DAILY_CAP, WATCHER_ALERT_MIN_GAP_MS, WATCHER_ALERT_REDRIVE_MS } from '../../lib/push/watcherAlert.ts';
import { createWatcherStore } from '../../lib/watchers/watcherStore.ts';
import { runWatcherTick } from '../../lib/jobs/internalJobs.ts';
import { upsertDevice } from '../../lib/push/deviceRegistry.ts';
import type { FcmMessage, MessagingClient } from '../../lib/push/pushService.ts';
import type { WatcherNotification } from '../../src/contracts/v1/watcherContracts.ts';
import {
  READINESS_CONTRACT_VERSION,
  READINESS_SCHEMA_VERSION,
  type ReadinessSnapshot,
} from '../../src/contracts/v1/readinessContracts.ts';
import { saveNormalizedReadinessSnapshot } from '../../lib/userState/userStateService.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';

const UID = 'watcherAlertUserxxxxxxxxxxxx'.slice(0, 28);
const INSTALLATION = '33333333-3333-4333-8333-333333333333';
// On the real clock: the tick reads readiness against "now", as it does deployed.
const T0 = new Date(Date.now() - 20 * 60_000);
const T1 = new Date(Date.now() - 10 * 60_000);

let storage: MemoryStorageAdapter;

function readiness(score: number, computedAt: string): ReadinessSnapshot {
  return {
    version: READINESS_CONTRACT_VERSION,
    schemaVersion: READINESS_SCHEMA_VERSION,
    scopeId: UID,
    computedAt,
    windowStart: '2026-09-19T20:00:00.000Z',
    windowEnd: computedAt,
    band: score < 0.3 ? 'low' : 'steady',
    score,
    normalizedSignals: {},
    subjective: null,
    derived: { readinessBand: score < 0.3 ? 'low' : 'steady', confidence: 0.8 },
    signals: [],
    sourceKinds: ['whoop'],
    missingSourceKinds: [],
  };
}

function fakeMessaging(): MessagingClient & { sent: FcmMessage[] } {
  const sent: FcmMessage[] = [];
  return {
    sent,
    async send(message: FcmMessage) {
      sent.push(message);
      return `projects/x/messages/${sent.length}`;
    },
  };
}

async function begin(): Promise<void> {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  await seedLiveAccount(UID, storage);
}

async function withDevice(locale: 'ar' | 'en' | 'he' = 'ar'): Promise<void> {
  await upsertDevice(UID, {
    installationId: INSTALLATION,
    fcmToken: `token-${INSTALLATION.replace(/-/g, '')}`,
    platform: 'ios',
    appVersion: '1.0.0',
    locale,
    timezone: 'Asia/Jerusalem',
    pushPermission: 'granted',
  }, T0.toISOString(), { storage });
}

async function readinessWatcher(effect: 'notify' | 'propose_commitment' | 'replan_if_impacted'): Promise<void> {
  await createWatcherStore(UID, storage).create({
    enabled: true,
    source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
    condition: { kind: 'digest_changed' },
    effect,
    createdBy: 'user',
  }, T0.toISOString());
}

async function tick(messaging: MessagingClient, at?: Date) {
  return runWatcherTick({ football: async () => ({ enabled: false }), messaging, ...(at ? { now: () => at } : {}) });
}

/** Primes on 0.82, then readiness drops to 0.21 and the next tick fires. */
async function primeThenDrop(messaging: MessagingClient) {
  await saveNormalizedReadinessSnapshot(UID, readiness(0.82, T0.toISOString()), { storage, now: T0.toISOString() });
  await tick(messaging);
  await saveNormalizedReadinessSnapshot(UID, readiness(0.21, T1.toISOString()), { storage, now: T1.toISOString() });
  return tick(messaging);
}

async function notifications(): Promise<WatcherNotification[]> {
  return (await storage.list<WatcherNotification>(userCol(UID, WATCHER_NOTIFICATIONS))).map((row) => row.data);
}

test('a notify watcher that fires sends one content-free push to the phone (CA6.1)', async () => {
  await begin();
  try {
    await withDevice('ar');
    await readinessWatcher('notify');
    const messaging = fakeMessaging();
    const totals = await primeThenDrop(messaging);
    assert.equal(totals.fired, 1, `the watcher did not fire: ${JSON.stringify(totals)}`);

    assert.equal(messaging.sent.length, 1, 'the firing never reached the phone');
    const [push] = messaging.sent;
    assert.equal(push!.data.kind, 'watcher_alert');
    // Identifiers only: nothing about the watcher, the signal or the reading.
    for (const key of Object.keys(push!.data)) {
      assert.ok(['kind', 'dedupeKey'].includes(key), `unexpected data key ${key}`);
    }
    assert.doesNotMatch(JSON.stringify(push), /readiness|0\.21|whoop|wtc_/i);
    assert.ok(!JSON.stringify(push).includes(UID), 'the account id went to Google and Apple');
    assert.ok(push!.notification.title.trim().length > 0);
    assert.ok(push!.notification.body.trim().length > 0);

    const [queued] = await notifications();
    assert.equal(queued!.state, 'sent', 'the notification still claims to be queued after its push went out');

    // The next quiet tick sends nothing more.
    await tick(messaging);
    assert.equal(messaging.sent.length, 1, 'one firing pushed twice');
  } finally {
    resetStorageForTests();
  }
});

test('the alert speaks the phone\'s language (CA6.1)', async () => {
  await begin();
  try {
    await withDevice('en');
    await readinessWatcher('notify');
    const messaging = fakeMessaging();
    await primeThenDrop(messaging);
    assert.equal(messaging.sent.length, 1);
    assert.match(messaging.sent[0]!.notification.title, /[A-Za-z]/);
    assert.doesNotMatch(messaging.sent[0]!.notification.title, /[؀-ۿ]/);
  } finally {
    resetStorageForTests();
  }
});

test('only notify pushes: a replan or a proposal sends nothing (CA6.1)', async () => {
  await begin();
  try {
    await withDevice();
    await readinessWatcher('replan_if_impacted');
    const messaging = fakeMessaging();
    const totals = await primeThenDrop(messaging);
    assert.equal(totals.fired, 1);
    assert.equal(messaging.sent.length, 0);
  } finally {
    resetStorageForTests();
  }
});

test('with no device to reach the notification stays queued and the sweep still counts the firing (CA6.1)', async () => {
  await begin();
  try {
    await readinessWatcher('notify');
    const messaging = fakeMessaging();
    const totals = await primeThenDrop(messaging);
    assert.equal(totals.fired, 1);
    assert.deepEqual(totals.failures, []);
    assert.equal(messaging.sent.length, 0);
    const [queued] = await notifications();
    assert.equal(queued!.state, 'queued');
  } finally {
    resetStorageForTests();
  }
});

/* ── Review round: bounds, re-drive, quiet hours, isolation ───────── */

const BOB = 'watcherAlertBobxxxxxxxxxxxxx'.slice(0, 28);
const BASE = new Date('2026-09-20T09:00:00.000Z');
const minutes = (n: number) => new Date(BASE.getTime() + n * 60_000);

async function checkIn(uid: string, score: number, at: Date): Promise<void> {
  await saveNormalizedReadinessSnapshot(uid, { ...readiness(score, at.toISOString()), scopeId: uid }, { storage, now: at.toISOString() });
}

async function deviceFor(uid: string, installationId: string): Promise<void> {
  await seedLiveAccount(uid, storage);
  await upsertDevice(uid, {
    installationId,
    fcmToken: `token-${installationId.replace(/-/g, '')}`,
    platform: 'android',
    appVersion: '1.0.0',
    locale: 'ar',
    timezone: 'UTC',
    pushPermission: 'granted',
  }, BASE.toISOString(), { storage });
}

async function watcherFor(uid: string): Promise<string> {
  const created = await createWatcherStore(uid, storage).create({
    enabled: true,
    source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
    condition: { kind: 'digest_changed' },
    effect: 'notify',
    createdBy: 'user',
  }, BASE.toISOString());
  return created.definition.watcherId;
}

/** A queued notification as the firing transaction writes it. */
async function queuedAt(uid: string, id: string, at: Date, watcherId = 'wtc_seeded'): Promise<void> {
  await storage.set(userSubDoc(uid, WATCHER_NOTIFICATIONS, id), {
    schemaVersion: 'watcher-notification-v1',
    notificationId: id,
    watcherId,
    scopeId: uid,
    state: 'queued',
    signalKind: 'readiness',
    subjectRef: 'self',
    reason: 'digest_changed',
    queuedAt: at.toISOString(),
    provenanceRef: 'userState/readiness',
  });
}

async function stateOf(uid: string, id: string): Promise<string | undefined> {
  return (await storage.get<WatcherNotification>(userSubDoc(uid, WATCHER_NOTIFICATIONS, id)))?.state;
}

test('rapid repeated firings of one watcher push exactly once inside the gap; every firing is still recorded', async () => {
  await begin();
  try {
    await withDevice('ar');
    await watcherFor(UID);
    const messaging = fakeMessaging();
    await checkIn(UID, 0.82, minutes(0));
    await tick(messaging, minutes(0));
    // Readiness jitters every minute for ten minutes.
    for (let n = 1; n <= 10; n += 1) {
      await checkIn(UID, n % 2 === 0 ? 0.82 : 0.21, minutes(n));
      await tick(messaging, minutes(n));
    }
    const fired = (await storage.list(userCol(UID, WATCHER_EVENTS))).length;
    assert.equal(fired, 10, 'a firing was dropped rather than only its push');
    assert.equal(messaging.sent.length, 1, `${messaging.sent.length} pushes inside one ${WATCHER_ALERT_MIN_GAP_MS / 60_000}-minute gap`);
  } finally {
    resetStorageForTests();
  }
});

test('after the gap the watcher pushes again, under the same collapse id so it replaces the last one', async () => {
  await begin();
  try {
    await withDevice('ar');
    await watcherFor(UID);
    const messaging = fakeMessaging();
    await checkIn(UID, 0.82, minutes(0));
    await tick(messaging, minutes(0));
    await checkIn(UID, 0.21, minutes(1));
    await tick(messaging, minutes(1));
    const later = 1 + WATCHER_ALERT_MIN_GAP_MS / 60_000 + 1;
    await checkIn(UID, 0.82, minutes(later));
    await tick(messaging, minutes(later));
    assert.equal(messaging.sent.length, 2);
    const [first, second] = messaging.sent;
    assert.notEqual(first!.data.dedupeKey, second!.data.dedupeKey);
    assert.equal(first!.apns.headers['apns-collapse-id'], second!.apns.headers['apns-collapse-id']);
    assert.equal(first!.android.notification.tag, second!.android.notification.tag);
    assert.notEqual(first!.apns.headers['apns-collapse-id'], first!.data.dedupeKey, 'the collapse id is per firing, not per watcher');
  } finally {
    resetStorageForTests();
  }
});

test('one account gets at most the daily cap of watcher alerts, across watchers', async () => {
  await begin();
  try {
    await withDevice('ar');
    const messaging = fakeMessaging();
    for (let n = 0; n < WATCHER_ALERT_DAILY_CAP + 3; n += 1) {
      await queuedAt(UID, `wtn_cap_${n}`, minutes(n), `wtc_cap_${n}`);
    }
    await tick(messaging, minutes(WATCHER_ALERT_DAILY_CAP + 4));
    assert.equal(messaging.sent.length, WATCHER_ALERT_DAILY_CAP);
  } finally {
    resetStorageForTests();
  }
});

test('a firing whose push never ran (a crash after the commit) is pushed on the next tick', async () => {
  await begin();
  try {
    await withDevice('ar');
    await watcherFor(UID);
    const messaging = fakeMessaging();
    await checkIn(UID, 0.82, minutes(0));
    await runWatcherSweep({ storage, now: minutes(0) });
    await checkIn(UID, 0.21, minutes(1));
    // The sweep commits the firing and the process dies before any push.
    assert.equal((await runWatcherSweep({ storage, now: minutes(1) })).fired, 1);
    const [queued] = await notifications();
    assert.equal(queued!.state, 'queued');

    await tick(messaging, minutes(2));
    assert.equal(messaging.sent.length, 1, 'the lost push was never re-driven');
    assert.equal(await stateOf(UID, queued!.notificationId), 'sent');
    await tick(messaging, minutes(3));
    assert.equal(messaging.sent.length, 1, 're-drive sent the same firing twice');
  } finally {
    resetStorageForTests();
  }
});

test('re-drive leaves alone what is too old, and marks sent what already went out', async () => {
  await begin();
  try {
    await withDevice('ar');
    const messaging = fakeMessaging();
    const now = minutes(100);
    const redriveMinutes = WATCHER_ALERT_REDRIVE_MS / 60_000;
    await queuedAt(UID, 'wtn_old', minutes(100 - redriveMinutes - 1), 'wtc_old');
    // Its watcher alerted a minute earlier, so it is inside its gap: only the
    // lock, not a fresh send, can be what marks it.
    await queuedAt(UID, 'wtn_recent', minutes(98), 'wtc_pushed');
    assert.equal(await deliverWatcherAlert(UID, 'wtn_recent', minutes(98), { storage, messaging }), 'sent');
    messaging.sent.length = 0;
    await queuedAt(UID, 'wtn_pushed', minutes(99), 'wtc_pushed');
    // Pushed before a crash that came before it could be marked: the lock exists.
    await storage.set(userSubDoc(UID, PUSH_LOG, docIdForKey(watcherAlertDedupeKey('wtn_pushed'))), {
      dedupeKey: watcherAlertDedupeKey('wtn_pushed'), kind: 'watcher_alert', createdAt: minutes(99).toISOString(), expiresAt: minutes(99 + 7 * 24 * 60).toISOString(),
    });
    await tick(messaging, now);
    assert.equal(messaging.sent.length, 0);
    assert.equal(await stateOf(UID, 'wtn_old'), 'queued', 'a stale alert was sent late');
    assert.equal(await stateOf(UID, 'wtn_pushed'), 'sent');
  } finally {
    resetStorageForTests();
  }
});

test('quiet hours hold an alert; it goes only if the window ends inside the re-drive time', async () => {
  await begin();
  try {
    await withDevice('ar');
    await saveRoutineProfile(UID, {
      timezone: 'UTC',
      sleepWindow: null,
      focusWindows: [],
      fixedCommitmentWindows: [],
      preferredReminderIntensity: 'softAwareness',
      quietHours: { start: '08:00', end: '09:20' },
      surveySkipped: false,
    }, BASE.toISOString(), { storage });
    const messaging = fakeMessaging();
    await queuedAt(UID, 'wtn_early', minutes(-50), 'wtc_early'); // 08:10
    await queuedAt(UID, 'wtn_late', minutes(5), 'wtc_late'); //     09:05
    await tick(messaging, minutes(6));
    assert.equal(messaging.sent.length, 0, 'pushed inside quiet hours');
    assert.equal(await stateOf(UID, 'wtn_late'), 'queued');
    // 09:21: the window is over. 09:05 is inside the re-drive time; 08:10 is not.
    await tick(messaging, minutes(21));
    assert.equal(messaging.sent.length, 1);
    assert.equal(await stateOf(UID, 'wtn_late'), 'sent');
    assert.equal(await stateOf(UID, 'wtn_early'), 'queued');
  } finally {
    resetStorageForTests();
  }
});

test('one account\'s alerts reach only its own devices, and its bounds do not touch another account', async () => {
  await begin();
  try {
    const ALICE_DEVICE = '44444444-4444-4444-8444-444444444444';
    const BOB_DEVICE = '55555555-5555-4555-8555-555555555555';
    await deviceFor(UID, ALICE_DEVICE);
    await deviceFor(BOB, BOB_DEVICE);
    await watcherFor(UID);
    await watcherFor(BOB);
    const messaging = fakeMessaging();
    await checkIn(UID, 0.82, minutes(0));
    await checkIn(BOB, 0.82, minutes(0));
    await tick(messaging, minutes(0));
    await checkIn(UID, 0.21, minutes(1));
    await tick(messaging, minutes(1));
    assert.deepEqual(messaging.sent.map((m) => m.token), [`token-${ALICE_DEVICE.replace(/-/g, '')}`]);
    // Alice is inside her gap; Bob is not held by it.
    await checkIn(BOB, 0.21, minutes(2));
    await tick(messaging, minutes(2));
    assert.deepEqual(messaging.sent.map((m) => m.token), [
      `token-${ALICE_DEVICE.replace(/-/g, '')}`,
      `token-${BOB_DEVICE.replace(/-/g, '')}`,
    ]);
    assert.deepEqual((await storage.list(userCol(BOB, WATCHER_NOTIFICATIONS))).length, 1);
  } finally {
    resetStorageForTests();
  }
});

test('a deleted account spends nothing: no push and no budget written under it', async () => {
  await begin();
  try {
    await withDevice('ar');
    await queuedAt(UID, 'wtn_gone', minutes(0), 'wtc_gone');
    await storage.delete(userDoc(UID));
    const messaging = fakeMessaging();
    assert.equal(await deliverWatcherAlert(UID, 'wtn_gone', minutes(1), { storage, messaging }), 'gone');
    assert.equal(messaging.sent.length, 0);
    assert.deepEqual(await storage.list(userCol(UID, PUSH_LOG)), []);
  } finally {
    resetStorageForTests();
  }
});

/* ── Review round 3: a send that throws, quiet hours, terminal states ── */

/** FCM answers with a transient failure — quota, auth, network — `failures` times. */
function flakyMessaging(failures: number): MessagingClient & { sent: FcmMessage[] } {
  const sent: FcmMessage[] = [];
  let left = failures;
  return {
    sent,
    async send(message: FcmMessage) {
      if (left > 0) {
        left -= 1;
        throw Object.assign(new Error('quota'), { code: 'messaging/quota-exceeded' });
      }
      sent.push(message);
      return `projects/x/messages/${sent.length}`;
    },
  };
}

test('a send that throws gives everything back: the next tick really sends, and only then is it sent', async () => {
  await begin();
  try {
    await withDevice('ar');
    await queuedAt(UID, 'wtn_flaky', minutes(0), 'wtc_flaky');
    const messaging = flakyMessaging(1);
    await assert.rejects(deliverWatcherAlert(UID, 'wtn_flaky', minutes(1), { storage, messaging }));
    assert.equal(await stateOf(UID, 'wtn_flaky'), 'queued', 'a push FCM refused was recorded as sent');
    assert.equal(messaging.sent.length, 0);

    // The tick that follows sends it — the gap, the day count and the lock
    // the failed attempt took do not stand in its way.
    await tick(messaging, minutes(2));
    assert.equal(messaging.sent.length, 1, 'the push lost to a transient FCM failure was never sent');
    assert.equal(await stateOf(UID, 'wtn_flaky'), 'sent');
  } finally {
    resetStorageForTests();
  }
});

test('re-drive checks quiet hours before it claims anything', async () => {
  await begin();
  try {
    await withDevice('ar');
    await saveRoutineProfile(UID, {
      timezone: 'UTC', sleepWindow: null, focusWindows: [], fixedCommitmentWindows: [],
      preferredReminderIntensity: 'softAwareness', quietHours: { start: '08:00', end: '10:00' }, surveySkipped: false,
    }, BASE.toISOString(), { storage });
    await queuedAt(UID, 'wtn_quiet', minutes(0), 'wtc_quiet');
    assert.equal(await deliverWatcherAlert(UID, 'wtn_quiet', minutes(1), { storage, messaging: fakeMessaging() }), 'suppressed_quiet_hours');
    assert.deepEqual(await storage.list(userCol(UID, PUSH_LOG)), [], 'quiet hours still claimed a budget');
    assert.equal(await stateOf(UID, 'wtn_quiet'), 'queued');
  } finally {
    resetStorageForTests();
  }
});

test('an alert held by the gap or the daily cap is settled as suppressed, not re-tried every minute', async () => {
  await begin();
  try {
    await withDevice('ar');
    const messaging = fakeMessaging();
    await queuedAt(UID, 'wtn_first', minutes(0), 'wtc_same');
    await queuedAt(UID, 'wtn_second', minutes(1), 'wtc_same');
    await tick(messaging, minutes(2));
    assert.equal(messaging.sent.length, 1);
    assert.equal(await stateOf(UID, 'wtn_first'), 'sent');
    assert.equal(await stateOf(UID, 'wtn_second'), 'suppressed');
  } finally {
    resetStorageForTests();
  }
});

test('one re-drive round stops at its time budget', async () => {
  await begin();
  try {
    await withDevice('ar');
    for (let n = 0; n < 3; n += 1) await queuedAt(UID, `wtn_budget_${n}`, minutes(n), `wtc_budget_${n}`);
    const messaging = fakeMessaging();
    const report = await redriveQueuedWatcherAlerts(minutes(5), { storage, messaging, budgetMs: 0 });
    assert.equal(report.sent, 0);
    assert.equal(report.stoppedEarly, true);
    assert.equal(messaging.sent.length, 0);
  } finally {
    resetStorageForTests();
  }
});

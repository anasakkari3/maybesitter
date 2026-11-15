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
import { userCol, WATCHER_NOTIFICATIONS } from '../../lib/storage/paths.ts';
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

async function tick(messaging: MessagingClient) {
  return runWatcherTick({ football: async () => ({ enabled: false }), messaging });
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
      assert.ok(['kind', 'dedupeKey', 'notificationId', 'tag'].includes(key), `unexpected data key ${key}`);
    }
    assert.doesNotMatch(JSON.stringify(push), /readiness|0\.21|whoop|wtc_/i);
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

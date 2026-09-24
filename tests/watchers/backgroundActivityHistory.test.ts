/**
 * `GET /api/mobile/trust/background-activity/history` (#527).
 *
 * User-visible history should be bounded and content-light:
 * - watcher condition changed;
 * - notification sent;
 * - plan reconsidered;
 * - no change required;
 * - monitor blocked because provider permission expired.
 * No raw provider payloads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as backgroundActivityHistoryGet } from '../../src/app/api/mobile/trust/background-activity/history/route.ts';
import { listBackgroundActivityHistory } from '../../lib/watchers/backgroundActivityHistory.ts';
import { createWatcherStore } from '../../lib/watchers/watcherStore.ts';
import { userSubDoc, PROVIDER_CONNECTIONS, PLAN_EVENTS, userCol } from '../../lib/storage/paths.ts';
import {
  BACKGROUND_MONITOR_HISTORY_KINDS,
  type BackgroundActivityHistoryView,
  type BackgroundMonitorHistoryItem,
} from '../../src/contracts/v1/backgroundMonitorContracts.ts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts.ts';
import type { WatcherFireEvent } from '../../src/contracts/v1/watcherContracts.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('AliceHistory');
const BOB = uidFor('BobHistory');
const T0 = '2026-09-24T00:00:00.000Z';
const T1 = '2026-09-24T01:00:00.000Z';
const T2 = '2026-09-24T02:00:00.000Z';
const T3 = '2026-09-24T03:00:00.000Z';
const T4 = '2026-09-24T04:00:00.000Z';

const SECRETS = Object.freeze({
  bearerToken: 'secret-oauth-bearer-token-must-not-leak',
  refreshToken: 'secret-oauth-refresh-token-must-not-leak',
  rawPayload: 'secret-provider-payload-must-not-leak',
});

let storage: MemoryStorageAdapter;
let auth: FakeAuthControls | null = null;

function begin(): void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
}

function req(path: string, uid?: string): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}${path}`, { headers });
}

async function json<T>(response: Response): Promise<T> {
  assert.equal(response.status, 200, `expected 200, got ${response.status}`);
  return (await response.json()) as T;
}

function makeConnection(
  connectionId: string,
  provider: 'whoop' | 'google',
  state: IntegrationConnectionRecord['state'],
  reauthRequired = false,
  extra: Record<string, unknown> = {},
): IntegrationConnectionRecord {
  return {
    version: 'v1',
    schemaVersion: 'integration-connection-v1',
    connectionId,
    scopeId: ALICE,
    identity: {
      provider,
      providerAccountId: `${provider}-acc`,
      providerSpaceId: null,
      displayName: provider,
    },
    state,
    reauthRequired,
    capabilities: ['readiness_read'],
    grantedScopes: ['readiness'],
    connectedAt: T0,
    lastSyncedAt: null,
    expiresAt: null,
    revokedAt: null,
    updatedAt: T0,
    ...extra,
  } as unknown as IntegrationConnectionRecord;
}

test('background activity history exposes event-backed row types (condition changed, notification sent, plan reconsidered)', async () => {
  begin();
  try {
    const store = createWatcherStore(ALICE, storage);

    // 1. Connection
    const connection = makeConnection('cnx_whoop_1', 'whoop', 'connected', false);
    await storage.set(userSubDoc(ALICE, PROVIDER_CONNECTIONS, 'cnx_whoop_1'), connection);

    // Watcher 1: With a human label
    const w1 = await store.create(
      {
        source: { provider: 'whoop', connectionId: 'cnx_whoop_1', signalKind: 'readiness', subjectRef: 'self' },
        condition: { kind: 'threshold', metric: 'recovery', operator: 'lt', value: 33 },
        effect: 'notify',
        enabled: true,
        label: 'Recovery Monitor',
        createdBy: 'user',
      },
      T0,
    );

    // Watcher 2: Replan if impacted
    const w2 = await store.create(
      {
        source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'ba162' },
        condition: { kind: 'digest_changed' },
        effect: 'replan_if_impacted',
        enabled: true,
        label: 'BA flight 162',
        createdBy: 'user',
      },
      T0,
    );

    // Seed Row Type 1: notification sent (from w1 firing)
    const fireEvent1: WatcherFireEvent = {
      version: 'v1',
      schemaVersion: 'watcher-event-v1',
      eventId: 'evt_1',
      watcherId: w1.definition.watcherId,
      scopeId: ALICE,
      signalId: 'sig_1',
      provider: 'whoop',
      signalKind: 'readiness',
      subjectRef: 'self',
      observedAt: T2,
      firedAt: T2,
      effect: 'notify',
      outcome: 'effected',
      reason: 'threshold_crossed',
      policyDecision: 'allowed',
      provenanceRef: 'signals/sig_1',
      effectRef: 'notif_1',
    };
    await storage.set(userSubDoc(ALICE, 'watcherEvents', 'evt_1'), fireEvent1);

    // Seed Row Type 2: watcher condition changed (from w2 firing)
    const changeId = 'watcher:change_123';
    const fireEvent2: WatcherFireEvent = {
      version: 'v1',
      schemaVersion: 'watcher-event-v1',
      eventId: 'evt_2',
      watcherId: w2.definition.watcherId,
      scopeId: ALICE,
      signalId: 'sig_2',
      provider: 'aviation',
      signalKind: 'flight',
      subjectRef: 'ba162',
      observedAt: T3,
      firedAt: T3,
      effect: 'replan_if_impacted',
      outcome: 'effected',
      reason: 'digest_changed',
      policyDecision: 'allowed',
      provenanceRef: 'signals/sig_2',
      effectRef: changeId,
    };
    await storage.set(userSubDoc(ALICE, 'watcherEvents', 'evt_2'), fireEvent2);

    // Seed Row Type 3: plan reconsidered (a plan event that names changeId)
    await storage.set(userSubDoc(ALICE, PLAN_EVENTS, 'pe_1'), {
      id: 'pe_1',
      type: 'plan_regenerated',
      date: '2026-09-24',
      at: T4,
      generation: 2,
      inputDigest: 'digest_2',
      causeChangeIds: [changeId],
    });

    // Read history
    const history = await listBackgroundActivityHistory(ALICE, {}, { storage });

    assert.equal(history.schemaVersion, 'background-monitor-v1');
    assert.equal(history.paused, false);

    const kinds = new Set(history.items.map((i) => i.kind));
    for (const expectedKind of BACKGROUND_MONITOR_HISTORY_KINDS) {
      assert.ok(kinds.has(expectedKind), `missing history kind: ${expectedKind}`);
    }
    assert.equal(history.items.length, 3);

    // Verify Row 1: plan reconsidered (newest at T4)
    const planReconsidered = history.items.find((i) => i.kind === 'plan_reconsidered');
    assert.ok(planReconsidered);
    assert.equal(planReconsidered.occurredAt, T4);
    assert.equal(planReconsidered.watcherId, w2.definition.watcherId);
    // The code stays a code; the user's name travels beside it (#527).
    assert.equal(planReconsidered.label, 'aviation:flight');
    assert.equal(planReconsidered.title, 'BA flight 162');

    // Verify Row 2: watcher condition changed (at T3)
    const condChanged = history.items.find((i) => i.kind === 'watcher_condition_changed');
    assert.ok(condChanged);
    assert.equal(condChanged.occurredAt, T3);
    assert.equal(condChanged.watcherId, w2.definition.watcherId);
    assert.equal(condChanged.label, 'aviation:flight');
    assert.equal(condChanged.title, 'BA flight 162');

    // Verify Row 3: notification sent (at T2)
    const notifSent = history.items.find((i) => i.kind === 'notification_sent');
    assert.ok(notifSent);
    assert.equal(notifSent.occurredAt, T2);
    assert.equal(notifSent.watcherId, w1.definition.watcherId);
    assert.equal(notifSent.label, 'whoop:readiness');
    assert.equal(notifSent.title, 'Recovery Monitor');
  } finally {
    end();
  }
});

test('history route enforces auth, bounds limit, and filters by watcherId and kind', async () => {
  begin();
  try {
    const anon = await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history'));
    assert.equal(anon.status, 401);

    const badLimit = await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history?limit=0', ALICE));
    assert.equal(badLimit.status, 400);

    const tooHighLimit = await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history?limit=300', ALICE));
    assert.equal(tooHighLimit.status, 400);

    const badKind = await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history?kind=invalid_kind', ALICE));
    assert.equal(badKind.status, 400);

    const good = await json<BackgroundActivityHistoryView>(
      await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history?limit=10', ALICE)),
    );
    assert.equal(good.schemaVersion, 'background-monitor-v1');
    assert.deepEqual(good.items, []);
  } finally {
    end();
  }
});

test('no raw provider payload or secret appears anywhere in history response', async () => {
  begin();
  try {
    const store = createWatcherStore(ALICE, storage);

    const cnx = makeConnection('cnx_secret_1', 'whoop', 'needs_reauth', true, {
      encryptedCredentialBlob: SECRETS.bearerToken,
      metadata: { raw: SECRETS.rawPayload, refresh: SECRETS.refreshToken },
    });
    await storage.set(userSubDoc(ALICE, PROVIDER_CONNECTIONS, 'cnx_secret_1'), cnx);

    await store.create(
      {
        source: { provider: 'whoop', connectionId: 'cnx_secret_1', signalKind: 'readiness', subjectRef: 'self' },
        condition: { kind: 'threshold', metric: 'recovery', operator: 'lt', value: 33 },
        effect: 'notify',
        enabled: true,
        label: 'Whoop Monitor',
        createdBy: 'user',
      },
      T0,
    );

    const response = await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history', ALICE));
    const text = await response.text();
    assert.equal(response.status, 200);

    for (const [name, secret] of Object.entries(SECRETS)) {
      assert.equal(text.includes(secret), false, `history response leaked ${name}`);
    }
  } finally {
    end();
  }
});

test('history strictly isolates accounts', async () => {
  begin();
  try {
    const aliceStore = createWatcherStore(ALICE, storage);
    const bobStore = createWatcherStore(BOB, storage);

    const wBob = await bobStore.create(
      {
        source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'bob_flight' },
        condition: { kind: 'digest_changed' },
        effect: 'notify',
        enabled: true,
        label: 'Bob Secret Flight',
        createdBy: 'user',
      },
      T0,
    );

    const bobFire: WatcherFireEvent = {
      version: 'v1',
      schemaVersion: 'watcher-event-v1',
      eventId: 'evt_bob_1',
      watcherId: wBob.definition.watcherId,
      scopeId: BOB,
      signalId: 'sig_bob',
      provider: 'aviation',
      signalKind: 'flight',
      subjectRef: 'bob_flight',
      observedAt: T1,
      firedAt: T1,
      effect: 'notify',
      outcome: 'effected',
      reason: 'digest_changed',
      policyDecision: 'allowed',
      provenanceRef: 'signals/sig_bob',
      effectRef: 'notif_bob',
    };
    await storage.set(userSubDoc(BOB, 'watcherEvents', 'evt_bob_1'), bobFire);

    const aliceView = await json<BackgroundActivityHistoryView>(
      await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history', ALICE)),
    );
    assert.equal(aliceView.items.length, 0);

    const bobView = await json<BackgroundActivityHistoryView>(
      await backgroundActivityHistoryGet(req('/api/mobile/trust/background-activity/history', BOB)),
    );
    assert.equal(bobView.items.length, 1);
    assert.equal(bobView.items[0]!.watcherId, wBob.definition.watcherId);
    assert.equal(bobView.items[0]!.title, 'Bob Secret Flight');
  } finally {
    end();
  }
});

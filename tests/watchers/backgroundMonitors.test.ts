/**
 * `GET /api/mobile/trust/background-activity` (#527, slice 1).
 *
 * The projection's job is to make background work inspectable, so most of what
 * follows is about the two ways a projection like this fails the user: by
 * telling them something that is no longer true, and by carrying something out
 * of the provider that was never theirs to show.
 *
 * The leak test is deliberately written over the **whole serialized response**
 * rather than field by field. A per-field check only covers the fields
 * somebody remembered to list, and the failure being guarded against is a
 * field nobody remembered — so the connection record and the watcher below are
 * seeded with marked values in every place a provider secret could plausibly
 * sit, and the assertion is that none of those strings survive anywhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as backgroundActivity } from '../../src/app/api/mobile/trust/background-activity/route.ts';
import { createWatcherStore, type StoredWatcher } from '../../lib/watchers/watcherStore.ts';
import {
  WATCHER_SWEEP_INTERVAL_MINUTES,
  backgroundMonitorStatusOf,
  listBackgroundActivity,
  monitorIdForWatcher,
} from '../../lib/watchers/backgroundMonitors.ts';
import { userSubDoc, PROVIDER_CONNECTIONS } from '../../lib/storage/paths.ts';
import type { IntegrationConnectionRecord } from '../../src/contracts/v1/integrationConnectionContracts.ts';
import type { BackgroundMonitorView } from '../../src/contracts/v1/backgroundMonitorContracts.ts';
import type { NewWatcherInput } from '../../lib/watchers/watcherStore.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('MonitorAlice');
const BOB = uidFor('MonitorBlake');
const NOW = '2026-09-20T09:00:00.000Z';

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

function request(uid?: string): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  return new Request(`${BASE}/api/mobile/trust/background-activity`, { headers });
}

/**
 * Every marked string below is something that must never reach a client: a
 * bearer token, a vault key, a provider permission name, a provider-authored
 * display name, a provider error code and an opaque sync cursor. They are
 * distinctive on purpose, so a leak is a substring match and not a judgement
 * call.
 */
const SECRETS = Object.freeze({
  token: 'ya29.LEAKED-ACCESS-TOKEN-must-never-ship',
  refresh: '1//LEAKED-REFRESH-TOKEN-must-never-ship',
  vaultKey: 'projects/leaky/secrets/whoop-oauth/versions/7',
  scope: 'https://www.googleapis.com/auth/calendar.readonly',
  displayName: 'Alice Al-Sayed (alice@example.com)',
  errorCode: 'PROVIDER_429_RATE_LIMIT_bucket_77',
  cursor: 'eyJwYWdlIjoicHJvdmlkZXItY3Vyc29yLTk5In0=',
});

function connection(
  uid: string,
  connectionId: string,
  state: IntegrationConnectionRecord['state'],
  extra: Record<string, unknown> = {},
): IntegrationConnectionRecord {
  return {
    version: 'v1',
    schemaVersion: 'integration-connection-v1',
    connectionId,
    scopeId: uid,
    identity: {
      provider: 'whoop',
      providerAccountId: 'whoop-account-7781',
      providerSpaceId: null,
      displayName: SECRETS.displayName,
    },
    state,
    capabilities: ['readiness_read'],
    grantedScopes: [SECRETS.scope],
    connectedAt: state === 'connected' ? NOW : null,
    lastSyncedAt: null,
    expiresAt: null,
    revokedAt: state === 'revoked' ? NOW : null,
    credentialRef: { vault: 'gcp-secret-manager', keyId: SECRETS.vaultKey, version: '7' },
    sync: { cursor: SECRETS.cursor, checkpointAt: NOW },
    errorCode: SECRETS.errorCode,
    updatedAt: NOW,
    // Not on the record's type; seeded anyway, because the failure being
    // guarded against is a projection that spreads a stored document.
    ...{ accessToken: SECRETS.token, refreshToken: SECRETS.refresh },
    ...extra,
  } as unknown as IntegrationConnectionRecord;
}

async function setConnection(
  uid: string,
  connectionId: string,
  state: IntegrationConnectionRecord['state'],
  extra: Record<string, unknown> = {},
): Promise<void> {
  await storage.set(userSubDoc(uid, PROVIDER_CONNECTIONS, connectionId), connection(uid, connectionId, state, extra));
}

function watcherInput(overrides: Partial<NewWatcherInput> = {}): NewWatcherInput {
  return {
    enabled: true,
    source: { provider: 'whoop', connectionId: 'cnx_whoop_1', signalKind: 'readiness', subjectRef: 'self' },
    condition: { kind: 'digest_changed' },
    effect: 'notify',
    createdBy: 'user',
    ...overrides,
  };
}

async function addWatcher(uid: string, overrides: Partial<NewWatcherInput> = {}): Promise<StoredWatcher> {
  return createWatcherStore(uid, storage).create(watcherInput(overrides), NOW);
}

async function monitors(uid: string): Promise<BackgroundMonitorView[]> {
  const response = await backgroundActivity(request(uid));
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { monitors: BackgroundMonitorView[] }).monitors;
}

/* ── One row per watcher, in each state the user can be in ───────── */

test('an active watcher is listed as active, with the next check it will actually make', async () => {
  begin();
  try {
    await setConnection(ALICE, 'cnx_whoop_1', 'connected');
    const watcher = await addWatcher(ALICE);

    const view = await listBackgroundActivity(ALICE, NOW, { storage });
    assert.equal(view.monitors.length, 1);
    const [monitor] = view.monitors;
    assert.deepEqual(monitor, {
      monitorId: monitorIdForWatcher(watcher.definition.watcherId),
      watcherId: watcher.definition.watcherId,
      connectionId: 'cnx_whoop_1',
      label: 'whoop:readiness',
      status: 'active',
      purpose: 'notice_any_change',
      effects: ['notify'],
      lastCheckedAt: null,
      lastChangedAt: null,
      nextCheckAt: '2026-09-20T09:01:00.000Z',
      canPause: true,
      canDelete: true,
    });
  } finally {
    end();
  }
});

test('a watcher the user turned off is paused, offers no pause, and promises no next check', async () => {
  begin();
  try {
    await setConnection(ALICE, 'cnx_whoop_1', 'connected');
    await addWatcher(ALICE, { enabled: false });

    const [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
    assert.equal(monitor!.status, 'paused');
    assert.equal(monitor!.canPause, false, 'a paused row offers Resume, not Pause');
    assert.equal(monitor!.canDelete, true, 'pausing something must not take away the ability to remove it');
    assert.equal(monitor!.nextCheckAt, null, 'a paused monitor will not look again, and must not say it will');
  } finally {
    end();
  }
});

test('a lapsed grant is needs_reauth, and a narrowed one is the same answer', async () => {
  begin();
  try {
    // Both are grants that exist and cannot be used, and the user fixes both
    // the same way, which is why the engine groups them and why this does.
    await addWatcher(ALICE);
    for (const state of ['needs_reauth', 'permission_limited'] as const) {
      await setConnection(ALICE, 'cnx_whoop_1', state);
      const [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
      assert.equal(monitor!.status, 'needs_reauth', `state ${state} should send the user to re-authorize`);
      assert.equal(monitor!.nextCheckAt, null);
    }
  } finally {
    end();
  }
});

test('a connection that is gone, revoked or never made is a permission block, not an error', async () => {
  begin();
  try {
    await addWatcher(ALICE);
    // No record at all: there is nothing to read through, which from the
    // user's side is the same as disconnected.
    let [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
    assert.equal(monitor!.status, 'blocked_permission');

    for (const state of ['revoked', 'not_connected', 'paused', 'connecting'] as const) {
      await setConnection(ALICE, 'cnx_whoop_1', state);
      [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
      assert.equal(monitor!.status, 'blocked_permission', `state ${state}`);
    }
  } finally {
    end();
  }
});

test('a provider in error, and a signal nothing observes, are both reported as error', async () => {
  begin();
  try {
    await setConnection(ALICE, 'cnx_whoop_1', 'error');
    await addWatcher(ALICE);
    let [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
    assert.equal(monitor!.status, 'error', 'a connection in error is not something the user can re-authorize away');

    // The other half: the connection is fine and no observer is registered for
    // the signal. Only the last sweep knows that, so it is the one input this
    // projection takes from the stored runtime rather than recomputing.
    await setConnection(BOB, 'cnx_whoop_1', 'connected');
    const watcher = await addWatcher(BOB);
    await storage.set(userSubDoc(BOB, 'watchers', watcher.definition.watcherId), {
      ...watcher,
      runtime: { ...watcher.runtime, status: 'blocked', blockedReason: 'signal_unavailable' },
    });
    [monitor] = (await listBackgroundActivity(BOB, NOW, { storage })).monitors;
    assert.equal(monitor!.status, 'error');
  } finally {
    end();
  }
});

test('a watcher needing no connection is active without one', async () => {
  begin();
  try {
    await addWatcher(ALICE, {
      source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
    });
    const [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
    assert.equal(monitor!.connectionId, null);
    assert.equal(monitor!.status, 'active', 'a watcher that needs no grant cannot be blocked by one');
  } finally {
    end();
  }
});

test('an account watching nothing gets an empty list, not an error and not a null', async () => {
  begin();
  try {
    const response = await backgroundActivity(request(ALICE));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      schemaVersion: 'background-monitor-v1',
      monitors: [],
    });
  } finally {
    end();
  }
});

/* ── The live answer, not the last sweep's ───────────────────────── */

test('revoking a connection changes the answer before any sweep runs', async () => {
  begin();
  try {
    await setConnection(ALICE, 'cnx_whoop_1', 'connected');
    const watcher = await addWatcher(ALICE);
    assert.equal(watcher.runtime.status, 'active', 'the stored runtime still says active');

    await setConnection(ALICE, 'cnx_whoop_1', 'revoked');

    const [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
    assert.equal(
      monitor!.status,
      'blocked_permission',
      'the screen read the last sweep\'s conclusion instead of the connection, and told the user a revoked provider was still being watched',
    );
  } finally {
    end();
  }
});

test('a connected record that still asks for re-auth is not reported as fine', async () => {
  begin();
  try {
    await setConnection(ALICE, 'cnx_whoop_1', 'connected', { reauthRequired: true });
    await addWatcher(ALICE);
    const [monitor] = (await listBackgroundActivity(ALICE, NOW, { storage })).monitors;
    assert.equal(monitor!.status, 'needs_reauth');
  } finally {
    end();
  }
});

/* ── Nothing of the provider's crosses the boundary ──────────────── */

test('no provider token, scope, cursor, account name or error code appears anywhere in the response', async () => {
  begin();
  try {
    // Every status the projection can produce, in one response, so the
    // assertion covers the blocked and errored paths too — those are the ones
    // most likely to reach for a provider's own error text.
    await setConnection(ALICE, 'cnx_whoop_1', 'connected');
    await setConnection(ALICE, 'cnx_whoop_2', 'needs_reauth');
    await setConnection(ALICE, 'cnx_whoop_3', 'error');
    await setConnection(ALICE, 'cnx_whoop_4', 'revoked');
    await addWatcher(ALICE, { source: { provider: 'whoop', connectionId: 'cnx_whoop_1', signalKind: 'readiness', subjectRef: 'self' } });
    await addWatcher(ALICE, { source: { provider: 'whoop', connectionId: 'cnx_whoop_2', signalKind: 'readiness', subjectRef: 'self' } });
    await addWatcher(ALICE, { source: { provider: 'whoop', connectionId: 'cnx_whoop_3', signalKind: 'readiness', subjectRef: 'self' } });
    await addWatcher(ALICE, { source: { provider: 'whoop', connectionId: 'cnx_whoop_4', signalKind: 'readiness', subjectRef: 'self' }, enabled: false });

    const response = await backgroundActivity(request(ALICE));
    const body = await response.text();
    assert.equal(response.status, 200);

    // The control: the marked values really are in storage, so a pass here is
    // the projection withholding them rather than the fixture never having
    // held them.
    const stored = JSON.stringify(await storage.get(userSubDoc(ALICE, PROVIDER_CONNECTIONS, 'cnx_whoop_1')));
    for (const [name, secret] of Object.entries(SECRETS)) {
      assert.ok(stored.includes(secret), `the ${name} fixture never reached storage, so this test proves nothing`);
      assert.equal(
        body.includes(secret),
        false,
        `the response carries the provider's ${name}: ${body}`,
      );
    }

    // And the positive half: it is not empty, and every row is made only of
    // keys this contract declares. A new field added without thinking is the
    // way the check above starts being bypassed.
    const parsed = JSON.parse(body) as { monitors: BackgroundMonitorView[] };
    assert.equal(parsed.monitors.length, 4);
    for (const monitor of parsed.monitors) {
      assert.deepEqual(Object.keys(monitor).sort(), [
        'canDelete', 'canPause', 'connectionId', 'effects', 'label', 'lastChangedAt',
        'lastCheckedAt', 'monitorId', 'nextCheckAt', 'purpose', 'status', 'watcherId',
      ]);
    }
  } finally {
    end();
  }
});

/* ── Whose monitors these are ────────────────────────────────────── */

test('one account never sees another\'s monitors, and an unauthenticated read sees none', async () => {
  begin();
  try {
    await setConnection(BOB, 'cnx_whoop_1', 'connected');
    await addWatcher(BOB);

    assert.deepEqual(await monitors(ALICE), [], 'Alice was shown what Bob is watching');
    assert.equal((await monitors(BOB)).length, 1);

    const anonymous = await backgroundActivity(request());
    assert.equal(anonymous.status, 401);
  } finally {
    end();
  }
});

/* ── The cadence is one number, in two places that must agree ────── */

test('the next-check cadence matches the sweep the infrastructure actually schedules', () => {
  // `nextCheckAt` is a promise to the user about when this app will look
  // again. It is derived from a constant, and the only thing that makes that
  // constant true is a crontab in a shell script nobody edits together with
  // this file.
  const scheduler = readFileSync(join(process.cwd(), 'infra/scheduler.sh'), 'utf8');
  const line = scheduler.split('\n').find((row) => row.includes('watcher-sweep-'));
  assert.ok(line, 'the watcher sweep is no longer scheduled by infra/scheduler.sh; nextCheckAt is now unfounded');
  const crontab = /"([^"]*\*[^"]*)"/.exec(line)?.[1];
  assert.equal(
    crontab,
    '* * * * *',
    `the sweep cadence changed to "${crontab}"; WATCHER_SWEEP_INTERVAL_MINUTES must change with it`,
  );
  assert.equal(WATCHER_SWEEP_INTERVAL_MINUTES, 1);
});

/* ── The unit the route is a thin wrapper over ───────────────────── */

test('the status function reads disabled, then the connection, then the observer — in that order', () => {
  // The same precedence the engine uses. A disabled watcher whose connection
  // is also revoked is *paused*, not blocked: the user turned it off, and
  // telling them a provider is at fault would send them to fix the wrong
  // thing.
  const base = {
    definition: { ...watcherInput(), watcherId: 'wtc_x', scopeId: ALICE } as never,
    runtime: { status: 'active', blockedReason: null } as never,
  } as StoredWatcher;
  const disabled = { ...base, definition: { ...base.definition, enabled: false } };
  assert.equal(backgroundMonitorStatusOf(disabled, connection(ALICE, 'cnx_whoop_1', 'revoked')), 'paused');

  // And with the connection healthy, a stale `signal_unavailable` still wins
  // over active, because nothing else can report it.
  const unobserved = { ...base, runtime: { status: 'blocked', blockedReason: 'signal_unavailable' } as never };
  assert.equal(backgroundMonitorStatusOf(unobserved, connection(ALICE, 'cnx_whoop_1', 'connected')), 'error');
});

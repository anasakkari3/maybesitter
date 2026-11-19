/**
 * QA audit de7fcb8, unit A6 — the watcher defects confirmed on staging
 * (Wave E, lane E3).
 *
 * - CA6.3 / CXA6.3: following an already-followed club with another effect
 *   answered 201 with the old watcher, unchanged (and still paused).
 * - CXA6.4: two concurrent follows of one club made two watchers.
 * - CA6.7: every «أنشئ متابعة» on the readiness builder made another identical
 *   watcher.
 * - CXA6.7: `POST /watchers {enabled:false}` answered `status:"active"`.
 * - CA6.4: with «وقّف كل المتابعة مؤقتًا» on, every monitor still said
 *   `active` with a next check one minute ahead.
 * - CXA6.6: `history?watcherId=` filtered only the newest 200 rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { userSubDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { GET as listWatchers, POST as createWatcher } from '../../src/app/api/mobile/watchers/route.ts';
import { POST as pauseWatcher } from '../../src/app/api/mobile/watchers/[id]/pause/route.ts';
import { GET as getBackgroundActivity } from '../../src/app/api/mobile/trust/background-activity/route.ts';
import { GET as getHistory } from '../../src/app/api/mobile/trust/background-activity/history/route.ts';
import { saveMonitoringSettings } from '../../lib/watchers/monitoringSettings.ts';
import type { WatcherFireEvent } from '../../src/contracts/v1/watcherContracts.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('WatcherWaveE3Alice');

let storage: MemoryStorageAdapter;
let auth: FakeAuthControls | null = null;
let previousKey: string | undefined;

async function begin(): Promise<void> {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  previousKey = process.env.FOOTBALL_DATA_API_KEY;
  process.env.FOOTBALL_DATA_API_KEY = 'test-key';
  await seedLiveAccount(ALICE);
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
  if (previousKey === undefined) delete process.env.FOOTBALL_DATA_API_KEY;
  else process.env.FOOTBALL_DATA_API_KEY = previousKey;
}

function request(path: string, body?: unknown): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(ALICE)}` });
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

function followBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    label: 'برشلونة',
    source: { provider: 'football_data', connectionId: null, signalKind: 'football_team', subjectRef: 'barcelona' },
    condition: { kind: 'digest_changed' },
    effect: 'replan_if_impacted',
    createdBy: 'user',
    ...overrides,
  };
}

/** The exact body the builder sends for «الجاهزية». */
function readinessBody(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
    condition: { kind: 'digest_changed' },
    effect: 'notify',
    createdBy: 'user',
    ...overrides,
  };
}

interface WireWatcher { watcherId: string; enabled: boolean; status: string; effect: string; source: { signalKind: string; subjectRef: string } }

async function created(response: Response): Promise<WireWatcher> {
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json() as { watcher: WireWatcher }).watcher;
}

async function all(): Promise<WireWatcher[]> {
  const response = await listWatchers(request('/api/mobile/watchers'));
  assert.equal(response.status, 200);
  return (await response.json() as { watchers: WireWatcher[] }).watchers;
}

test('CA6.3: following a followed club with another effect changes the effect and resumes it', async () => {
  await begin();
  try {
    const first = await created(await createWatcher(request('/api/mobile/watchers', followBody())));
    assert.equal(first.effect, 'replan_if_impacted');
    const paused = await pauseWatcher(request(`/api/mobile/watchers/${first.watcherId}/pause`, { paused: true }), params(first.watcherId));
    assert.equal(paused.status, 200);

    const again = await created(await createWatcher(request('/api/mobile/watchers', followBody({ effect: 'notify' }))));
    assert.equal(again.watcherId, first.watcherId, 'still one follow, one watcher');
    assert.equal(again.effect, 'notify', 'the new choice is kept');
    assert.equal(again.enabled, true, '«تابِع» on a paused follow resumes it');

    const stored = await all();
    assert.equal(stored.length, 1);
    assert.equal(stored[0]!.effect, 'notify');
    assert.equal(stored[0]!.enabled, true);
  } finally {
    end();
  }
});

test('CXA6.4: two concurrent follows of one club make one watcher', async () => {
  await begin();
  try {
    const [left, right] = await Promise.all([
      createWatcher(request('/api/mobile/watchers', followBody({ effect: 'notify' }))),
      createWatcher(request('/api/mobile/watchers', followBody({ effect: 'notify' }))),
    ]);
    const a = await created(left);
    const b = await created(right);
    assert.equal(a.watcherId, b.watcherId);
    assert.equal((await all()).length, 1);
  } finally {
    end();
  }
});

test('CA6.7: creating the same readiness watch twice keeps one watcher; another effect is another watch', async () => {
  await begin();
  try {
    const first = await created(await createWatcher(request('/api/mobile/watchers', readinessBody())));
    const second = await created(await createWatcher(request('/api/mobile/watchers', readinessBody())));
    assert.equal(second.watcherId, first.watcherId);
    const [c, d] = await Promise.all([
      createWatcher(request('/api/mobile/watchers', readinessBody())),
      createWatcher(request('/api/mobile/watchers', readinessBody())),
    ]);
    assert.equal((await created(c)).watcherId, first.watcherId);
    assert.equal((await created(d)).watcherId, first.watcherId);
    assert.equal((await all()).length, 1);

    const replan = await created(await createWatcher(request('/api/mobile/watchers', readinessBody({ effect: 'replan_if_impacted' }))));
    assert.notEqual(replan.watcherId, first.watcherId);
    assert.equal((await all()).length, 2);
  } finally {
    end();
  }
});

test('CXA6.7: a watcher created disabled says paused at once, not active', async () => {
  await begin();
  try {
    const off = await created(await createWatcher(request('/api/mobile/watchers', readinessBody({ enabled: false }))));
    assert.equal(off.enabled, false);
    assert.equal(off.status, 'paused');
    const listed = (await all()).find((watcher) => watcher.watcherId === off.watcherId)!;
    assert.equal(listed.status, 'paused');
  } finally {
    end();
  }
});

interface Monitor { watcherId: string; status: string; nextCheckAt: string | null; canPause: boolean }

test('CA6.4: with pause-all on, no monitor says it is live or names a next check', async () => {
  await begin();
  try {
    const watcher = await created(await createWatcher(request('/api/mobile/watchers', readinessBody())));
    const before = await (await getBackgroundActivity(request('/api/mobile/trust/background-activity'))).json() as { monitors: Monitor[] };
    assert.equal(before.monitors[0]!.status, 'active');

    await saveMonitoringSettings(ALICE, true);
    const view = await (await getBackgroundActivity(request('/api/mobile/trust/background-activity'))).json() as { paused: boolean; monitors: Monitor[] };
    assert.equal(view.paused, true);
    const monitor = view.monitors.find((row) => row.watcherId === watcher.watcherId)!;
    assert.equal(monitor.status, 'paused');
    assert.equal(monitor.nextCheckAt, null);
    // The row's own switch still pauses this one watch: it is enabled.
    assert.equal(monitor.canPause, true);
  } finally {
    end();
  }
});

function firing(eventId: string, watcherId: string, firedAt: string): WatcherFireEvent {
  return {
    version: 'v1',
    schemaVersion: 'watcher-event-v1',
    eventId,
    watcherId,
    scopeId: ALICE,
    signalId: `sig_${eventId}`,
    provider: 'maybesitter',
    signalKind: 'readiness',
    subjectRef: 'self',
    observedAt: firedAt,
    firedAt,
    effect: 'notify',
    outcome: 'effected',
    reason: 'digest_changed',
    policyDecision: 'allowed',
    provenanceRef: `signals/sig_${eventId}`,
    effectRef: `notif_${eventId}`,
  } as WatcherFireEvent;
}

test('CXA6.6: history filtered by watcher reaches that watcher behind 200 newer firings of others', async () => {
  await begin();
  try {
    const old = await created(await createWatcher(request('/api/mobile/watchers', readinessBody())));
    const busy = await created(await createWatcher(request('/api/mobile/watchers', readinessBody({ effect: 'replan_if_impacted' }))));
    await storage.set(userSubDoc(ALICE, 'watcherEvents', 'evt_old_1'), firing('evt_old_1', old.watcherId, '2026-11-01T06:19:00.000Z'));
    await storage.set(userSubDoc(ALICE, 'watcherEvents', 'evt_old_2'), firing('evt_old_2', old.watcherId, '2026-11-01T06:20:00.000Z'));
    for (let i = 0; i < 210; i += 1) {
      const at = new Date(Date.parse('2026-11-02T00:00:00.000Z') + i * 60_000).toISOString();
      await storage.set(userSubDoc(ALICE, 'watcherEvents', `evt_busy_${i}`), { ...firing(`evt_busy_${i}`, busy.watcherId, at), effect: 'replan_if_impacted' });
    }
    for (const id of [old.watcherId, `mon_${old.watcherId}`]) {
      const response = await getHistory(request(`/api/mobile/trust/background-activity/history?watcherId=${id}&limit=50`));
      assert.equal(response.status, 200);
      const body = await response.json() as { items: { watcherId: string }[] };
      assert.equal(body.items.length, 2, `filter by ${id}`);
      assert.ok(body.items.every((item) => item.watcherId === old.watcherId));
    }
  } finally {
    end();
  }
});

/**
 * The readiness watcher, the one source that works today, end to end through
 * the routes the phone calls (closure CL7, «تابعلي هذا الإشي»).
 *
 * The owner's complaint had two halves: every source was unavailable, and the
 * settings at the bottom of the screen did not save. This file holds the
 * second half and the readiness half of the first, through the real handlers
 * and the *deployed* observer registry (`defaultWatcherSignalRegistry`, no
 * injected observer):
 *
 *   - the builder's bottom choice (the effect) is what the server stores and
 *     what the watcher screen reads back;
 *   - the pause switch on the watcher screen saves and reads back;
 *   - an energy check-in through `/api/mobile/readiness` changes the signal,
 *     and the per-minute sweep fires the chosen effect for it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { PLANNING_STATE_CHANGES, userCol } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as listWatchers, POST as createWatcher } from '../../src/app/api/mobile/watchers/route.ts';
import { PUT as checkIn } from '../../src/app/api/mobile/readiness/route.ts';
import {
  GET as getBackgroundActivity,
  PATCH as setBackgroundActivity,
} from '../../src/app/api/mobile/trust/background-activity/route.ts';
import { GET as getMonitoring } from '../../src/app/api/mobile/settings/monitoring/route.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('ReadinessChainAlice');

let auth: FakeAuthControls | null = null;

function begin(): void {
  setStorageForTests(createMemoryStorage());
  auth = installFakeAuth();
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
}

function request(path: string, options: { method?: string; body?: unknown } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(ALICE)}` });
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** The exact body `createReadinessWatcher` (mobile) sends, with the effect the user picked at the bottom. */
function readinessBody(effect: string) {
  return {
    enabled: true,
    source: { provider: 'maybesitter', connectionId: null, signalKind: 'readiness', subjectRef: 'self' },
    condition: { kind: 'digest_changed' },
    effect,
    createdBy: 'user',
  };
}

async function energy(level: number, observedAt: string): Promise<void> {
  const response = await checkIn(request('/api/mobile/readiness', { method: 'PUT', body: { energy: level, observedAt } }));
  assert.equal(response.status, 200, await response.clone().text());
}

test('the effect chosen at the bottom of the builder is saved and read back, and a readiness change fires it', async () => {
  begin();
  try {
    const now = Date.now();
    await energy(4, new Date(now - 60_000).toISOString());

    const created = await createWatcher(request('/api/mobile/watchers', { body: readinessBody('replan_if_impacted') }));
    assert.equal(created.status, 201, await created.clone().text());
    const watcherId = (await created.json() as { watcher: { watcherId: string } }).watcher.watcherId;

    // Read back through both reads the app makes.
    const listed = await (await listWatchers(request('/api/mobile/watchers'))).json() as { items: Array<{ effect: string }> };
    assert.deepEqual(listed.items.map((item) => item.effect), ['replan_if_impacted']);
    const activity = await (await getBackgroundActivity(request('/api/mobile/trust/background-activity'))).json() as {
      monitors: Array<{ watcherId: string; status: string; effects: string[]; label: string }>;
    };
    assert.deepEqual(activity.monitors.map((m) => [m.watcherId, m.status, m.effects, m.label]), [
      [watcherId, 'active', ['replan_if_impacted'], 'maybesitter:readiness'],
    ]);

    // Sweep one primes on the current reading; the user's energy drops; sweep
    // two fires the chosen effect — through the deployed registry.
    const primed = await runWatcherSweep({ now: new Date(now) });
    assert.equal(primed.fired, 0);
    assert.equal(primed.failures.length, 0);
    await energy(1, new Date(now + 30_000).toISOString());
    const fired = await runWatcherSweep({ now: new Date(now + 60_000) });
    assert.equal(fired.fired, 1, JSON.stringify(fired));
    const changes = await getStorage().list<{ source: string; entityId: string }>(userCol(ALICE, PLANNING_STATE_CHANGES));
    assert.deepEqual(changes.map((row) => [row.data.source, row.data.entityId]), [['watcher', watcherId]]);
  } finally {
    end();
  }
});

test('the pause switch on the watcher screen saves and reads back on both reads', async () => {
  begin();
  try {
    const paused = await setBackgroundActivity(request('/api/mobile/trust/background-activity', { method: 'PATCH', body: { paused: true } }));
    assert.equal(paused.status, 200);
    assert.equal((await paused.json() as { paused: boolean }).paused, true);
    assert.equal((await (await getBackgroundActivity(request('/api/mobile/trust/background-activity'))).json() as { paused: boolean }).paused, true);
    assert.equal((await (await getMonitoring(request('/api/mobile/settings/monitoring'))).json() as { paused: boolean }).paused, true);

    const resumed = await setBackgroundActivity(request('/api/mobile/trust/background-activity', { method: 'PATCH', body: { paused: false } }));
    assert.equal((await resumed.json() as { paused: boolean }).paused, false);
    assert.equal((await (await getBackgroundActivity(request('/api/mobile/trust/background-activity'))).json() as { paused: boolean }).paused, false);
  } finally {
    end();
  }
});

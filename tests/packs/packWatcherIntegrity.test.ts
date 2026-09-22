/**
 * A pack's watchers cannot be prised loose from their pack (#528, slice 2).
 *
 * `enabled` is a field a client can write, and `createdBy` was a field a
 * client could claim. Both are load-bearing for the entitlement gate, so both
 * are exercised here over the *real* `/api/mobile/watchers/**` handlers with
 * real auth and real storage, rather than against the helper functions they
 * call — the defect these tests exist for was reachable with one HTTP request,
 * and a unit test of the guard would not have been able to say so.
 *
 * The invariant underneath all of it: every `pack_template` watcher in an
 * account's tree appears on exactly one installation record. A watcher that
 * appears on none cannot be switched off by anything in the product, because
 * the record is the only pack→watcher link there is.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as createWatcher } from '../../src/app/api/mobile/watchers/route.ts';
import { DELETE as deleteWatcher, PATCH as patchWatcher } from '../../src/app/api/mobile/watchers/[id]/route.ts';
import { POST as pauseWatcher } from '../../src/app/api/mobile/watchers/[id]/pause/route.ts';
import { createWatcherStore, type StoredWatcher } from '../../lib/watchers/watcherStore.ts';
import { userDoc, WATCHERS } from '../../lib/storage/paths.ts';
import { disablePack, enablePack, listPackInstallations } from '../../lib/packs/packLifecycle.ts';
import { packsClaiming } from '../../lib/packs/packWatcherGuard.ts';
import { FOOTBALL_PACK } from '../../lib/packs/catalog.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('PackAlice');
const NOW = '2026-09-22T09:00:00.000Z';

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

function request(path: string, options: { uid?: string; method?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.uid) headers.set('authorization', `Bearer ${tokenFor(options.uid)}`);
  return new Request(`${BASE}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

async function installFootball(): Promise<readonly string[]> {
  await storage.set(userDoc(ALICE), { uid: ALICE });
  const outcome = await enablePack({
    pack: FOOTBALL_PACK,
    scopeId: ALICE,
    provider: 'football_data',
    connectionId: 'conn_football',
    subjects: Object.fromEntries(FOOTBALL_PACK.watcherTemplates.map((t) => [t.templateId, 'match_4711'])),
    entitlement: null,
    now: NOW,
    storage,
  });
  assert.equal(outcome.state, 'enabled');
  assert.ok(outcome.watcherIds.length >= 2, 'the fixture pack should install more than one watcher');
  return outcome.watcherIds;
}

/* ── The client may not mint a pack watcher ──────────────────────── */

test('POST /api/mobile/watchers refuses a client-supplied createdBy of pack_template', async () => {
  begin();
  try {
    const response = await createWatcher(request('/api/mobile/watchers', {
      uid: ALICE,
      body: {
        source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'flt_1' },
        condition: { kind: 'digest_changed' },
        effect: 'notify',
        createdBy: 'pack_template',
      },
    }));
    const text = await response.text();
    assert.equal(response.status, 400, text);
    assert.match(text, /createdBy/);

    // And the refusal is a refusal, not a silent downgrade: nothing was made.
    const rows = (await storage.listGroup<StoredWatcher>(WATCHERS))
      .filter((row) => row.path.startsWith(`${userDoc(ALICE)}/`));
    assert.deepEqual(rows, [], 'a refused create left a watcher behind');
  } finally {
    end();
  }
});

test('a watcher a client does create is attributed to the user, and stays enable-able', async () => {
  begin();
  try {
    const response = await createWatcher(request('/api/mobile/watchers', {
      uid: ALICE,
      body: {
        source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'flt_1' },
        condition: { kind: 'digest_changed' },
        effect: 'notify',
        createdBy: 'user',
      },
    }));
    assert.equal(response.status, 201);
    const { watcher } = await response.json() as { watcher: { watcherId: string; createdBy: string } };
    assert.equal(watcher.createdBy, 'user');

    // The paired success: the guard must not have locked ordinary watchers.
    const paused = await pauseWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}/pause`, { uid: ALICE, body: { paused: true } }),
      params(watcher.watcherId),
    );
    assert.equal(paused.status, 200);
    const resumed = await pauseWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}/pause`, { uid: ALICE, body: { paused: false } }),
      params(watcher.watcherId),
    );
    assert.equal(resumed.status, 200, await resumed.text());
  } finally {
    end();
  }
});

/* ── A disabled pack's watchers cannot be resumed from the API ───── */

test('the pause route refuses to resume a watcher whose pack is disabled', async () => {
  begin();
  try {
    const watcherIds = await installFootball();
    // Paired success first: while the pack is enabled, the route works.
    const allowed = await pauseWatcher(
      request(`/api/mobile/watchers/${watcherIds[0]}/pause`, { uid: ALICE, body: { paused: false } }),
      params(watcherIds[0]!),
    );
    assert.equal(allowed.status, 200, await allowed.text());

    await disablePack({ scopeId: ALICE, packId: FOOTBALL_PACK.packId, now: NOW, storage });

    for (const watcherId of watcherIds) {
      const response = await pauseWatcher(
        request(`/api/mobile/watchers/${watcherId}/pause`, { uid: ALICE, body: { paused: false } }),
        params(watcherId),
      );
      const text = await response.text();
      assert.equal(response.status, 409, `the pause route resumed a disabled pack's watcher: ${text}`);
      assert.match(text, /football/);
      const stored = await createWatcherStore(ALICE, storage).get(watcherId);
      assert.equal(stored?.definition.enabled, false, 'the refusal still wrote the flag');
    }
  } finally {
    end();
  }
});

test('the PATCH route refuses to enable a watcher whose pack is disabled, but still allows disabling it', async () => {
  begin();
  try {
    const watcherIds = await installFootball();
    await disablePack({ scopeId: ALICE, packId: FOOTBALL_PACK.packId, now: NOW, storage });
    const watcherId = watcherIds[0]!;

    const enabling = await patchWatcher(
      request(`/api/mobile/watchers/${watcherId}`, { uid: ALICE, method: 'PATCH', body: { enabled: true } }),
      params(watcherId),
    );
    assert.equal(enabling.status, 409, await enabling.text());

    // The guard is one-directional: turning something further off is never
    // the thing it exists to stop.
    const disabling = await patchWatcher(
      request(`/api/mobile/watchers/${watcherId}`, { uid: ALICE, method: 'PATCH', body: { enabled: false } }),
      params(watcherId),
    );
    assert.equal(disabling.status, 200, await disabling.text());
  } finally {
    end();
  }
});

test('an unattributable pack watcher cannot be switched on by anybody', async () => {
  begin();
  try {
    await storage.set(userDoc(ALICE), { uid: ALICE });
    // The state a crashed install used to be able to leave behind. It must not
    // be reachable any more, but if one ever appears it fails closed rather
    // than running unstoppably.
    const orphan = await createWatcherStore(ALICE, storage).create({
      enabled: false,
      source: { provider: 'football_data', connectionId: null, signalKind: 'fixture', subjectRef: 'match_orphan' },
      condition: { kind: 'digest_changed' },
      effect: 'notify',
      createdBy: 'pack_template',
    }, NOW);

    const response = await pauseWatcher(
      request(`/api/mobile/watchers/${orphan.definition.watcherId}/pause`, { uid: ALICE, body: { paused: false } }),
      params(orphan.definition.watcherId),
    );
    assert.equal(response.status, 409, await response.text());
    assert.deepEqual(await packsClaiming(ALICE, orphan.definition.watcherId, { storage }), []);
  } finally {
    end();
  }
});

/* ── The invariant itself ────────────────────────────────────────── */

/**
 * Every pack watcher in the tree is claimed by exactly one installation.
 *
 * This is the assertion the whole attribution design rests on, so it runs
 * over the storage itself rather than over a return value: whatever put a
 * `pack_template` watcher there — a route, a lifecycle call, a half-finished
 * install — it must be findable from a record.
 */
async function assertEveryPackWatcherIsClaimed(uid: string): Promise<number> {
  const watchers = (await storage.listGroup<StoredWatcher>(WATCHERS))
    .filter((row) => row.path.startsWith(`${userDoc(uid)}/`))
    .map((row) => row.data)
    .filter((stored) => stored.definition.createdBy === 'pack_template');
  const records = await listPackInstallations(uid, { storage });
  for (const stored of watchers) {
    const claims = records.filter((record) => record.watcherIds.includes(stored.definition.watcherId));
    assert.equal(
      claims.length,
      1,
      `${stored.definition.watcherId} is claimed by ${claims.length} installation records; `
        + 'a pack watcher claimed by none can never be switched off, and one claimed by two '
        + 'is stopped by whichever pack is disabled first',
    );
  }
  return watchers.length;
}

test('a completed install leaves every pack watcher claimed by exactly one record', async () => {
  begin();
  try {
    await installFootball();
    assert.equal(await assertEveryPackWatcherIsClaimed(ALICE), FOOTBALL_PACK.watcherTemplates.length);
  } finally {
    end();
  }
});

test('an install missing a subject creates nothing at all, so no watcher is left unclaimed', async () => {
  begin();
  try {
    await storage.set(userDoc(ALICE), { uid: ALICE });
    const [first] = FOOTBALL_PACK.watcherTemplates;
    await assert.rejects(
      enablePack({
        pack: FOOTBALL_PACK,
        scopeId: ALICE,
        provider: 'football_data',
        connectionId: 'conn_football',
        // A subject for the first template and none for the second — the
        // partial install that used to leave a live, unstoppable watcher.
        subjects: { [first!.templateId]: 'match_4711' },
        entitlement: null,
        now: NOW,
        storage,
      }),
      /without a subject/,
    );

    const rows = (await storage.listGroup<StoredWatcher>(WATCHERS))
      .filter((row) => row.path.startsWith(`${userDoc(ALICE)}/`));
    assert.deepEqual(rows, [], 'a failed install left a watcher behind');
    assert.deepEqual(await listPackInstallations(ALICE, { storage }), []);
    assert.equal(await assertEveryPackWatcherIsClaimed(ALICE), 0);
  } finally {
    end();
  }
});

test('an install whose record write fails undoes the watchers it already created', async () => {
  begin();
  try {
    await storage.set(userDoc(ALICE), { uid: ALICE });
    const realSet = storage.set.bind(storage);
    // Fail exactly the installation-record write, after both watchers exist.
    storage.set = (async (path: string, value: unknown) => {
      if (path.includes('/packInstallations/')) throw new Error('storage exploded');
      return realSet(path, value as never);
    }) as typeof storage.set;

    await assert.rejects(installFootball(), /storage exploded/);
    storage.set = realSet;

    const rows = (await storage.listGroup<StoredWatcher>(WATCHERS))
      .filter((row) => row.path.startsWith(`${userDoc(ALICE)}/`));
    assert.deepEqual(rows, [], 'a failed record write left orphaned pack watchers behind');
    assert.equal(await assertEveryPackWatcherIsClaimed(ALICE), 0);
  } finally {
    end();
  }
});

test('deleting a pack watcher stops the record claiming it, and a re-enable reinstalls the template', async () => {
  begin();
  try {
    const watcherIds = await installFootball();
    const victim = watcherIds[0]!;
    const response = await deleteWatcher(
      request(`/api/mobile/watchers/${victim}`, { uid: ALICE, method: 'DELETE' }),
      params(victim),
    );
    assert.equal(response.status, 200, await response.text());

    const [record] = await listPackInstallations(ALICE, { storage });
    assert.ok(record);
    assert.ok(!record.watcherIds.includes(victim), 'the record still claims a watcher that is gone');
    assert.equal(record.watcherIds.length, watcherIds.length - 1);
    assert.equal(
      record.templateIds.length,
      record.watcherIds.length,
      'watcherIds and templateIds drifted out of step, so a re-enable cannot tell what is installed',
    );
    assert.equal(await assertEveryPackWatcherIsClaimed(ALICE), watcherIds.length - 1);

    // The template is uninstalled now, so toggling the pack brings it back.
    const again = await enablePack({
      pack: FOOTBALL_PACK,
      scopeId: ALICE,
      provider: 'football_data',
      connectionId: 'conn_football',
      subjects: Object.fromEntries(FOOTBALL_PACK.watcherTemplates.map((t) => [t.templateId, 'match_4711'])),
      entitlement: null,
      now: NOW,
      storage,
    });
    assert.equal(again.watcherIds.length, FOOTBALL_PACK.watcherTemplates.length);
    assert.ok(!again.watcherIds.includes(victim), 'the deleted watcher came back from the dead');
    assert.equal(await assertEveryPackWatcherIsClaimed(ALICE), FOOTBALL_PACK.watcherTemplates.length);
  } finally {
    end();
  }
});

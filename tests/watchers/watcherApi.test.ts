/**
 * `/api/mobile/watchers/**` (#525): what a client may configure, and what it
 * may read back.
 *
 * The routes are thin, so most of what is asserted here is the boundary rather
 * than the handler: a body cannot choose whose tree it writes into, cannot
 * name an Action Policy capability, cannot repoint a watcher at a new subject
 * while keeping its baseline, and cannot read another account's history by
 * knowing an id. Each of those is a way this feature could have become a
 * privacy or a safety defect rather than a bug.
 *
 * Every refusal is paired with the success it refuses, on the same data, so a
 * 404 here never passes because the route is broken for everyone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { GET as listWatchers, POST as createWatcher } from '../../src/app/api/mobile/watchers/route.ts';
import { DELETE as deleteWatcher, PATCH as patchWatcher } from '../../src/app/api/mobile/watchers/[id]/route.ts';
import { POST as pauseWatcher } from '../../src/app/api/mobile/watchers/[id]/pause/route.ts';
import { GET as watcherHistory } from '../../src/app/api/mobile/watchers/[id]/history/route.ts';
import { createWatcherStore } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { createWatcherSignalRegistry, type WatcherSignalObserver } from '../../lib/watchers/signals.ts';
import { WATCHER_SIGNAL_SCHEMA_VERSION } from '../../src/contracts/v1/watcherContracts.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('WatcherAlice');
const BOB = uidFor('WatcherBlake');

let storage: MemoryStorageAdapter;
let auth: FakeAuthControls | null = null;

/** A one-subject synthetic source, so the API tests can make a real firing happen. */
let syntheticDigest = 'digest-one';
const syntheticObserver: WatcherSignalObserver = {
  supports: (source) => source.signalKind === 'flight',
  async observe(source, context) {
    return {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `flight:${source.subjectRef}:${syntheticDigest}`,
      provider: source.provider,
      signalKind: 'flight',
      subjectRef: source.subjectRef,
      observedAt: context.now,
      stateDigest: syntheticDigest,
      provenanceRef: `flights/${source.subjectRef}`,
      measures: [],
    };
  },
};

function begin(): void {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  syntheticDigest = 'digest-one';
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

const FLIGHT = {
  provider: 'aviation',
  connectionId: null,
  signalKind: 'flight',
  subjectRef: 'flt_ly315_20260920',
} as const;

function newWatcher(overrides: Record<string, unknown> = {}) {
  return { source: { ...FLIGHT }, condition: { kind: 'digest_changed' }, effect: 'notify', ...overrides };
}

async function created(uid: string, body: Record<string, unknown> = newWatcher()): Promise<{ watcherId: string }> {
  const response = await createWatcher(request('/api/mobile/watchers', { uid, body }));
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return (JSON.parse(text) as { watcher: { watcherId: string } }).watcher;
}

async function sweep(now: string): Promise<void> {
  await runWatcherSweep({
    storage,
    now: new Date(now),
    registry: createWatcherSignalRegistry([syntheticObserver]),
  });
}

/* ── The happy path ───────────────────────────────────────────────── */

test('a watcher can be created, listed, retuned, paused, resumed and deleted', async () => {
  begin();
  try {
    const watcher = await created(ALICE);
    assert.match(watcher.watcherId, /^wtc_/);

    const listed = await (await listWatchers(request('/api/mobile/watchers', { uid: ALICE }))).json() as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0]!.enabled, true);
    assert.equal(listed.items[0]!.status, 'active');
    assert.equal(listed.items[0]!.effect, 'notify');
    assert.equal(listed.items[0]!.createdBy, 'user');
    assert.equal(listed.items[0]!.fireCount, 0);
    // No engine internals on the wire: the baseline digest is how a client
    // could infer provider state the contract does not carry.
    for (const forbidden of ['lastDigest', 'lastMeasures', 'lastSignalId']) {
      assert.ok(!(forbidden in listed.items[0]!), `${forbidden} is on the wire`);
    }

    const retuned = await patchWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}`, { uid: ALICE, method: 'PATCH', body: { effect: 'replan_if_impacted' } }),
      params(watcher.watcherId),
    );
    assert.equal(retuned.status, 200);
    assert.equal((await retuned.json() as { watcher: { effect: string } }).watcher.effect, 'replan_if_impacted');

    const paused = await pauseWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}/pause`, { uid: ALICE, method: 'POST', body: {} }),
      params(watcher.watcherId),
    );
    const pausedBody = await paused.json() as { watcher: { enabled: boolean; status: string } };
    assert.equal(pausedBody.watcher.enabled, false);
    // Parked immediately rather than at the next sweep: the API must never
    // describe a watcher as running after the user turned it off.
    assert.equal(pausedBody.watcher.status, 'paused');

    const resumed = await pauseWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}/pause`, { uid: ALICE, method: 'POST', body: { paused: false } }),
      params(watcher.watcherId),
    );
    assert.equal((await resumed.json() as { watcher: { enabled: boolean } }).watcher.enabled, true);

    const removed = await deleteWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}`, { uid: ALICE, method: 'DELETE' }),
      params(watcher.watcherId),
    );
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (await (await listWatchers(request('/api/mobile/watchers', { uid: ALICE }))).json() as { items: unknown[] }).items,
      [],
    );
    // Deleting something that is already gone is a 404, not a second success.
    assert.equal((await deleteWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}`, { uid: ALICE, method: 'DELETE' }),
      params(watcher.watcherId),
    )).status, 404);
  } finally {
    end();
  }
});

/* ── What a body may not say ──────────────────────────────────────── */

test('a body cannot choose the account, the id, the capability or an unknown field', async () => {
  begin();
  try {
    // A body naming somebody else's account creates nothing of theirs — the
    // key is refused outright rather than dropped, so a client is told.
    const impersonation = await createWatcher(request('/api/mobile/watchers', {
      uid: ALICE,
      body: { ...newWatcher(), scopeId: BOB, watcherId: 'wtc_chosen' },
    }));
    assert.equal(impersonation.status, 400);
    assert.equal((await impersonation.json() as { reason: string }).reason, 'unknown_field');

    // The effect vocabulary is closed. A capability id is not an effect, and
    // there is no field through which one could be smuggled.
    for (const effect of ['create_calendar_event', 'update_external_task', 'send_message', 'notify_user', '']) {
      const response = await createWatcher(request('/api/mobile/watchers', { uid: ALICE, body: newWatcher({ effect }) }));
      assert.equal(response.status, 400, `"${effect}" was accepted as an effect`);
      assert.equal((await response.json() as { reason: string }).reason, 'invalid_effect');
    }

    // Normalized vocabulary, not free text: a signal kind or a subject that
    // could carry a payload is refused at the door.
    const badKind = await createWatcher(request('/api/mobile/watchers', {
      uid: ALICE, body: newWatcher({ source: { ...FLIGHT, signalKind: 'GET /v2/flights?ident=LY315' } }),
    }));
    assert.equal((await badKind.json() as { reason: string }).reason, 'invalid_signal_kind');
    const badSubject = await createWatcher(request('/api/mobile/watchers', {
      uid: ALICE, body: newWatcher({ source: { ...FLIGHT, subjectRef: '{"flight": {"ident": "LY315"}}' } }),
    }));
    assert.equal((await badSubject.json() as { reason: string }).reason, 'invalid_subject_ref');

    // A malformed condition cannot reach the evaluator.
    for (const condition of [{ kind: 'always' }, { kind: 'threshold', metric: 'x', operator: 'eq', value: 1 }, { kind: 'threshold', metric: 'readiness_score', operator: 'lt', value: 'low' }]) {
      const response = await createWatcher(request('/api/mobile/watchers', { uid: ALICE, body: newWatcher({ condition }) }));
      assert.equal((await response.json() as { reason: string }).reason, 'invalid_condition', JSON.stringify(condition));
    }

    // And the same body without any of that is accepted, so none of the above
    // passed because creation is simply broken.
    const ok = await createWatcher(request('/api/mobile/watchers', { uid: ALICE, body: newWatcher() }));
    assert.equal(ok.status, 201);
  } finally {
    end();
  }
});

test('a watcher cannot be repointed at a new subject in place', async () => {
  begin();
  try {
    const watcher = await created(ALICE);
    const response = await patchWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}`, {
        uid: ALICE, method: 'PATCH', body: { source: { ...FLIGHT, subjectRef: 'flt_somebody_else' } },
      }),
      params(watcher.watcherId),
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { reason: string }).reason, 'source_immutable');

    // The subject really is unchanged, not merely refused in the response.
    const stored = (await createWatcherStore(ALICE, storage).get(watcher.watcherId))!;
    assert.equal(stored.definition.source.subjectRef, FLIGHT.subjectRef);
  } finally {
    end();
  }
});

test('an edit clears the baseline, so retuning a watcher cannot itself make it fire', async () => {
  begin();
  try {
    const watcher = await created(ALICE);
    await sweep('2026-09-20T09:00:00.000Z');
    const primed = (await createWatcherStore(ALICE, storage).get(watcher.watcherId))!;
    assert.equal(primed.runtime.lastDigest, 'digest-one', 'the watcher never primed, so this test proves nothing');

    // The subject moves while the watcher is being retuned.
    syntheticDigest = 'digest-two';
    await patchWatcher(
      request(`/api/mobile/watchers/${watcher.watcherId}`, { uid: ALICE, method: 'PATCH', body: { effect: 'propose_commitment' } }),
      params(watcher.watcherId),
    );
    const reset = (await createWatcherStore(ALICE, storage).get(watcher.watcherId))!;
    assert.equal(reset.runtime.lastDigest, null, 'the edit kept a baseline that answered a different question');

    await sweep('2026-09-20T09:01:00.000Z');
    const history = await (await watcherHistory(
      request(`/api/mobile/watchers/${watcher.watcherId}/history`, { uid: ALICE }),
      params(watcher.watcherId),
    )).json() as { items: unknown[] };
    assert.deepEqual(history.items, [], 'the retuned watcher fired on the change it was retuned during');

    // And the very next change does fire, so re-priming is not silencing.
    syntheticDigest = 'digest-three';
    await sweep('2026-09-20T09:02:00.000Z');
    const after = await (await watcherHistory(
      request(`/api/mobile/watchers/${watcher.watcherId}/history`, { uid: ALICE }),
      params(watcher.watcherId),
    )).json() as { items: Array<Record<string, unknown>> };
    assert.equal(after.items.length, 1);
  } finally {
    end();
  }
});

/* ── History ──────────────────────────────────────────────────────── */

test('the history carries a reason, a policy decision and provenance for every row, newest first', async () => {
  begin();
  try {
    const watcher = await created(ALICE);
    await sweep('2026-09-20T09:00:00.000Z');
    syntheticDigest = 'digest-two';
    await sweep('2026-09-20T09:01:00.000Z');
    syntheticDigest = 'digest-three';
    await sweep('2026-09-20T09:02:00.000Z');

    const response = await watcherHistory(
      request(`/api/mobile/watchers/${watcher.watcherId}/history`, { uid: ALICE }),
      params(watcher.watcherId),
    );
    assert.equal(response.status, 200);
    const body = await response.json() as { watcherId: string; items: Array<Record<string, string | null>> };
    assert.equal(body.watcherId, watcher.watcherId);
    assert.equal(body.items.length, 2);
    assert.ok(body.items[0]!.firedAt! > body.items[1]!.firedAt!, 'the history is not newest-first');
    for (const row of body.items) {
      assert.equal(row.reason, 'digest_changed');
      assert.equal(row.policyDecision, 'allowed');
      assert.equal(row.outcome, 'effected');
      assert.ok(row.provenanceRef && row.provenanceRef.length > 0);
      assert.ok(row.effectRef && row.effectRef.length > 0);
      assert.ok(!('stateDigest' in row), 'the history leaks the observed digest');
    }

    const limited = await watcherHistory(
      request(`/api/mobile/watchers/${watcher.watcherId}/history?limit=1`, { uid: ALICE }),
      params(watcher.watcherId),
    );
    assert.equal((await limited.json() as { items: unknown[] }).items.length, 1);

    for (const limit of ['0', '-1', '1000', 'all', '1.5']) {
      const refused = await watcherHistory(
        request(`/api/mobile/watchers/${watcher.watcherId}/history?limit=${limit}`, { uid: ALICE }),
        params(watcher.watcherId),
      );
      assert.equal(refused.status, 400, `limit=${limit} was accepted`);
    }
  } finally {
    end();
  }
});

/* ── Isolation ────────────────────────────────────────────────────── */

test("one account's watchers and history are invisible to another, id or no id", async () => {
  begin();
  try {
    const hers = await created(ALICE);
    const his = await created(BOB);
    await sweep('2026-09-20T09:00:00.000Z');
    syntheticDigest = 'digest-two';
    await sweep('2026-09-20T09:01:00.000Z');

    // Both accounts watch the same flight and both fired: the isolation below
    // is not the absence of data.
    for (const uid of [ALICE, BOB]) {
      const own = await watcherHistory(
        request(`/api/mobile/watchers/${uid === ALICE ? hers.watcherId : his.watcherId}/history`, { uid }),
        params(uid === ALICE ? hers.watcherId : his.watcherId),
      );
      assert.equal((await own.json() as { items: unknown[] }).items.length, 1, `${uid} has no history of their own`);
    }

    const listed = await (await listWatchers(request('/api/mobile/watchers', { uid: ALICE }))).json() as {
      items: Array<{ watcherId: string }>;
    };
    assert.deepEqual(listed.items.map((item) => item.watcherId), [hers.watcherId]);

    // Knowing Bob's watcher id buys Alice nothing on any of the four routes,
    // and every refusal is the same 404 a watcher that never existed gets.
    for (const [name, call] of [
      ['history', () => watcherHistory(request(`/api/mobile/watchers/${his.watcherId}/history`, { uid: ALICE }), params(his.watcherId))],
      ['patch', () => patchWatcher(request(`/api/mobile/watchers/${his.watcherId}`, { uid: ALICE, method: 'PATCH', body: { enabled: false } }), params(his.watcherId))],
      ['pause', () => pauseWatcher(request(`/api/mobile/watchers/${his.watcherId}/pause`, { uid: ALICE, method: 'POST', body: {} }), params(his.watcherId))],
      ['delete', () => deleteWatcher(request(`/api/mobile/watchers/${his.watcherId}`, { uid: ALICE, method: 'DELETE' }), params(his.watcherId))],
    ] as const) {
      assert.equal((await call()).status, 404, `Alice reached Bob's watcher through ${name}`);
    }

    // And Bob's watcher was not touched by any of those attempts.
    const bobs = (await createWatcherStore(BOB, storage).get(his.watcherId))!;
    assert.equal(bobs.definition.enabled, true);
    assert.equal(bobs.runtime.fireCount, 1);
  } finally {
    end();
  }
});

test('every watcher route refuses an unauthenticated or forged caller', async () => {
  begin();
  try {
    const watcher = await created(ALICE);
    const id = watcher.watcherId;
    const calls: Array<[string, (uid?: string) => Promise<Response>]> = [
      ['GET /watchers', (uid) => listWatchers(request('/api/mobile/watchers', uid ? { uid } : {}))],
      ['POST /watchers', (uid) => createWatcher(request('/api/mobile/watchers', { ...(uid ? { uid } : {}), body: newWatcher() }))],
      ['PATCH /watchers/{id}', (uid) => patchWatcher(request(`/api/mobile/watchers/${id}`, { ...(uid ? { uid } : {}), method: 'PATCH', body: { enabled: false } }), params(id))],
      ['DELETE /watchers/{id}', (uid) => deleteWatcher(request(`/api/mobile/watchers/${id}`, { ...(uid ? { uid } : {}), method: 'DELETE' }), params(id))],
      ['POST /watchers/{id}/pause', (uid) => pauseWatcher(request(`/api/mobile/watchers/${id}/pause`, { ...(uid ? { uid } : {}), method: 'POST', body: {} }), params(id))],
      ['GET /watchers/{id}/history', (uid) => watcherHistory(request(`/api/mobile/watchers/${id}/history`, uid ? { uid } : {}), params(id))],
    ];
    for (const [name, call] of calls) {
      assert.equal((await call()).status, 401, `${name} answered an unauthenticated caller`);
    }
    // The guard is the token's verification, not the presence of a header.
    auth!.refuse(ALICE, 'invalid_token');
    assert.equal((await calls[0]![1](ALICE)).status, 401);
    auth!.allow(ALICE);
    assert.equal((await calls[0]![1](ALICE)).status, 200);
  } finally {
    end();
  }
});

test('a path segment that is not a watcher id is refused before any read', async () => {
  begin();
  try {
    await created(ALICE);
    for (const id of ['..', 'users/other/watchers/x', 'wtc_', '*', 'wtc_not-a-uuid']) {
      const response = await watcherHistory(
        request(`/api/mobile/watchers/${encodeURIComponent(id)}/history`, { uid: ALICE }),
        params(id),
      );
      assert.equal(response.status, 400, `"${id}" was treated as a watcher id`);
      assert.equal((await response.json() as { reason: string }).reason, 'invalid_watcher_id');
    }
  } finally {
    end();
  }
});

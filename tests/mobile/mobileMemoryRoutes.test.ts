/**
 * The memory and profile routes (UC-2.7a, #167).
 *
 * ── The isolation tests are the point of this file ───────────────
 *
 * `RuntimeMemoryStore` addresses records by id alone, through a
 * collection-group query, because that API predates there being a user tree.
 * That makes a bare `mem_…` id a capability: without the scope check in
 * `memoryService`, knowing one would be enough to read, rewrite or delete a
 * stranger's memory. Several tests below do exactly that and require a 404 —
 * and a 404 rather than a 403, because a 403 would confirm the record exists.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { GET as profileGet } from '../../src/app/api/mobile/profile/route.ts';
import { PUT as routinePut } from '../../src/app/api/mobile/profile/routine/route.ts';
import {
  DELETE as memoryDeleteAll,
  GET as memoryGet,
  POST as memoryPost,
} from '../../src/app/api/mobile/memory/route.ts';
import {
  DELETE as memoryDelete,
  PATCH as memoryPatch,
} from '../../src/app/api/mobile/memory/[id]/route.ts';
import { listAuditEvents } from '../../lib/pilot/pilotTrustStore.ts';
import { getStorage } from '../../lib/storage/index.ts';
import { MEMORY, USER_SCOPED_COLLECTIONS, userDoc } from '../../lib/storage/paths.ts';

const baseUrl = 'http://127.0.0.1:4321';
const OWNER = uidFor('MemoryOwner');
const STRANGER = uidFor('MemoryStranger');

let auth: FakeAuthControls | null = null;
let previousFlag: string | undefined;

function begin(flag = 'true'): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  previousFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
  process.env.MAYBESITTER_FEATURE_MEMORY = flag;
}

function end(): void {
  if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY;
  else process.env.MAYBESITTER_FEATURE_MEMORY = previousFlag;
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function request(uid: string, path: string, options: { body?: unknown; method?: string } = {}): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

const ROUTINE = {
  timezone: 'Asia/Jerusalem',
  sleepWindow: { start: '23:30', end: '07:30' },
  focusWindows: [{ start: '09:00', end: '17:00', label: 'work_study' }],
  fixedCommitmentWindows: [],
  preferredReminderIntensity: 'followUp',
  quietHours: { start: '22:30', end: '07:30' },
  surveySkipped: false,
};

async function addManual(uid: string, content: string, kind = 'fact'): Promise<string> {
  const created = await json(await memoryPost(
    request(uid, '/api/mobile/memory', { body: { kind, content, language: 'en' } }),
  ));
  assert.equal(created.success, true, `creating "${content}" failed: ${JSON.stringify(created)}`);
  return created.memory.id as string;
}

// ── The survey round trip ────────────────────────────────────────

test('the survey saved through the route comes back on the profile and as facts', async () => {
  begin();
  try {
    const saved = await json(await routinePut(request(OWNER, '/api/mobile/profile/routine', {
      body: ROUTINE, method: 'PUT',
    })));
    assert.equal(saved.success, true);

    const profile = await json(await profileGet(request(OWNER, '/api/mobile/profile')));
    assert.equal(profile.routine.quietHours.start, '22:30');
    assert.equal(profile.updatedAt, profile.routine.updatedAt);

    const listed = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    const contents = listed.items.map((item: any) => item.content).sort();
    assert.deepEqual(contents, [
      'focus_window:09:00-17:00',
      'quiet_hours:22:30-07:30',
      'reminder_intensity:followUp',
      'sleep_window:23:30-07:30',
    ]);
    for (const item of listed.items) {
      assert.equal(item.provenance.origin, 'routine_survey', 'a survey answer lost its provenance');
    }
  } finally {
    end();
  }
});

test('the list comes back in the same order every time', async () => {
  begin();
  try {
    // The routine facts are one save, so they share an `observedAt` and a
    // `createdAt`. The store breaks that tie on a random uuid, which made the
    // memory screen reshuffle its rows on every pull-to-refresh — on the one
    // screen whose whole job is telling somebody what we know about them.
    await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));

    const reads = await Promise.all([1, 2, 3].map(async () => {
      const listed = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
      return listed.items.map((item: any) => item.content);
    }));
    assert.deepEqual(reads[0], reads[1]);
    assert.deepEqual(reads[1], reads[2]);
    // And it is an order somebody could predict, not merely a repeatable one.
    assert.deepEqual(reads[0], [
      'focus_window:09:00-17:00',
      'quiet_hours:22:30-07:30',
      'reminder_intensity:followUp',
      'sleep_window:23:30-07:30',
    ]);
  } finally {
    end();
  }
});

test('a profile nobody has answered reads as null rather than as a 404', async () => {
  begin();
  try {
    const response = await profileGet(request(OWNER, '/api/mobile/profile'));
    assert.equal(response.status, 200);
    // Every field null, and asserted as a whole shape on purpose: this is the
    // response an account sees before it has answered anything, and a field
    // that quietly started arriving populated would be this route claiming
    // knowledge of somebody who has told it nothing. `aiContextImport` joins
    // the list with the AI context import — null until they bring one over.
    assert.deepEqual(await json(response), { routine: null, updatedAt: null, aiContextImport: null });
  } finally {
    end();
  }
});

test('an invalid routine body is refused rather than partly stored', async () => {
  begin();
  try {
    for (const [label, body] of [
      ['a bad zone', { ...ROUTINE, timezone: 'Mars/Olympus' }],
      ['a bad clock time', { ...ROUTINE, quietHours: { start: '25:00', end: '07:30' } }],
      ['a zero-length window', { ...ROUTINE, quietHours: { start: '22:30', end: '22:30' } }],
      ['an unknown intensity', { ...ROUTINE, preferredReminderIntensity: 'shouting' }],
    ] as const) {
      const response = await routinePut(request(OWNER, '/api/mobile/profile/routine', { body, method: 'PUT' }));
      assert.equal(response.status, 400, `${label} was accepted`);
      assert.equal((await json(response)).reason, 'invalid_profile');
    }
    const profile = await json(await profileGet(request(OWNER, '/api/mobile/profile')));
    assert.equal(profile.routine, null, 'a refused save still wrote something');
  } finally {
    end();
  }
});

// ── Manual facts ─────────────────────────────────────────────────

test('a manual fact is stored as the user speaking, whatever the body claims', async () => {
  begin();
  try {
    const response = await memoryPost(request(OWNER, '/api/mobile/memory', {
      // `source` and `confidence` are not fields the client may set. Sending
      // them must change nothing: a model guess cannot be smuggled in as one.
      body: { kind: 'goal', content: 'Finish the thesis', language: 'en', source: 'model_inferred', confidence: 0.1 },
    }));
    assert.equal(response.status, 201);
    const created = (await json(response)).memory;
    assert.equal(created.source, 'user_stated');
    assert.equal(created.confidence, 1);
    assert.equal(created.kind, 'goal');
    assert.equal(created.provenance.origin, 'manual');
  } finally {
    end();
  }
});

test('a manual fact is refused when it is empty, too long, or of a kind nobody may file', async () => {
  begin();
  try {
    for (const [label, body] of [
      ['empty', { kind: 'fact', content: '   ', language: 'en' }],
      ['201 characters', { kind: 'fact', content: 'x'.repeat(201), language: 'en' }],
      ['a hypothesis', { kind: 'hypothesis', content: 'They seem tired', language: 'en' }],
      ['an unknown language', { kind: 'fact', content: 'Hello', language: 'fr' }],
    ] as const) {
      const response = await memoryPost(request(OWNER, '/api/mobile/memory', { body }));
      assert.equal(response.status, 400, `${label} was accepted`);
    }
    // 200 exactly is allowed: the bound is inclusive.
    const ok = await memoryPost(request(OWNER, '/api/mobile/memory', {
      body: { kind: 'fact', content: 'x'.repeat(200), language: 'en' },
    }));
    assert.equal(ok.status, 201);
  } finally {
    end();
  }
});

// ── Editing ──────────────────────────────────────────────────────

test('editing a fact returns a new id and hides the old record from the list', async () => {
  begin();
  try {
    const id = await addManual(OWNER, 'Call the clinic on Mondays');
    const patched = await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${id}`, { body: { content: 'Call the clinic on Tuesdays' }, method: 'PATCH' }),
      params(id),
    ));
    assert.equal(patched.success, true);
    assert.notEqual(patched.memory.id, id, 'an edit reused the id instead of superseding');

    const listed = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    const contents = listed.items.map((item: any) => item.content);
    assert.deepEqual(contents, ['Call the clinic on Tuesdays']);
  } finally {
    end();
  }
});

test('editing a superseded record is refused rather than forking the chain', async () => {
  begin();
  try {
    const id = await addManual(OWNER, 'First');
    await memoryPatch(request(OWNER, `/api/mobile/memory/${id}`, { body: { content: 'Second' }, method: 'PATCH' }), params(id));
    const again = await memoryPatch(
      request(OWNER, `/api/mobile/memory/${id}`, { body: { content: 'Third' }, method: 'PATCH' }),
      params(id),
    );
    assert.equal(again.status, 404);
  } finally {
    end();
  }
});

// ── Deleting ─────────────────────────────────────────────────────

test('deleting a fact removes its whole supersession chain, not just the visible record', async () => {
  begin();
  try {
    const first = await addManual(OWNER, 'Version one');
    const second = (await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${first}`, { body: { content: 'Version two' }, method: 'PATCH' }),
      params(first),
    ))).memory.id as string;
    const third = (await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${second}`, { body: { content: 'Version three' }, method: 'PATCH' }),
      params(second),
    ))).memory.id as string;

    // Delete the *middle* record: the chain must still go both ways.
    const deleted = await json(await memoryDelete(
      request(OWNER, `/api/mobile/memory/${second}`, { method: 'DELETE' }),
      params(second),
    ));
    assert.equal(deleted.deleted, 3, 'the chain was not removed whole');

    const store = createStorageRuntimeMemoryStore();
    for (const id of [first, second, third]) {
      assert.equal(await store.get(id), null, `${id} survived the delete`);
    }
    assert.deepEqual(await store.listAll(OWNER), [], 'a document was left in the tree');
  } finally {
    end();
  }
});

test('delete-all removes superseded and revoked history too', async () => {
  begin();
  try {
    await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));
    await routinePut(request(OWNER, '/api/mobile/profile/routine', {
      body: { ...ROUTINE, quietHours: null, sleepWindow: { start: '01:00', end: '09:00' } },
      method: 'PUT',
    }));
    const before = await createStorageRuntimeMemoryStore().listAll(OWNER);
    assert.ok(before.some((r) => r.status === 'superseded'), 'this run proves nothing without a superseded record');
    assert.ok(before.some((r) => r.status === 'revoked'), 'this run proves nothing without a revoked record');

    const response = await json(await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' })));
    assert.equal(response.success, true);
    assert.deepEqual(await createStorageRuntimeMemoryStore().listAll(OWNER), []);
  } finally {
    end();
  }
});

test('a deletion is audited by count, never by content', async () => {
  begin();
  try {
    await addManual(OWNER, 'Something private about my health');
    const id = await addManual(OWNER, 'Another private sentence');
    await memoryDelete(request(OWNER, `/api/mobile/memory/${id}`, { method: 'DELETE' }), params(id));

    const audit = await listAuditEvents(OWNER);
    const deletion = audit.find((event) => event.eventType === 'memory_deleted');
    assert.ok(deletion, 'the deletion was not audited');
    const serialised = JSON.stringify(audit);
    assert.ok(!serialised.includes('private'), `audit carries memory content: ${serialised}`);
    assert.ok(!serialised.includes(id), 'audit carries the deleted record id');
  } finally {
    end();
  }
});

// ── Isolation ────────────────────────────────────────────────────

test('one account cannot read, edit or delete another account’s memory', async () => {
  begin();
  try {
    const id = await addManual(OWNER, "The owner's private sentence");

    const listed = await json(await memoryGet(request(STRANGER, '/api/mobile/memory')));
    assert.deepEqual(listed.items, [], "a stranger's list showed the owner's memory");

    const patched = await memoryPatch(
      request(STRANGER, `/api/mobile/memory/${id}`, { body: { content: 'Rewritten' }, method: 'PATCH' }),
      params(id),
    );
    assert.equal(patched.status, 404, 'a stranger edited the owner’s memory');
    assert.equal((await json(patched)).reason, 'memory_not_found');

    const deleted = await memoryDelete(
      request(STRANGER, `/api/mobile/memory/${id}`, { method: 'DELETE' }),
      params(id),
    );
    assert.equal(deleted.status, 404, 'a stranger deleted the owner’s memory');

    // And none of those attempts touched it.
    const still = await createStorageRuntimeMemoryStore().get(id);
    assert.equal(still?.content, "The owner's private sentence");
  } finally {
    end();
  }
});

test('an unknown id and someone else’s id are answered identically', async () => {
  begin();
  try {
    const id = await addManual(OWNER, 'Owned');
    const theirs = await memoryDelete(
      request(STRANGER, `/api/mobile/memory/${id}`, { method: 'DELETE' }), params(id),
    );
    const missing = await memoryDelete(
      request(STRANGER, '/api/mobile/memory/mem_00000000-0000-4000-8000-000000000000', { method: 'DELETE' }),
      params('mem_00000000-0000-4000-8000-000000000000'),
    );
    assert.equal(theirs.status, missing.status);
    assert.deepEqual(await json(theirs), await json(missing));
  } finally {
    end();
  }
});

test('delete-all deletes only the caller’s tree', async () => {
  begin();
  try {
    await addManual(OWNER, 'Mine');
    await addManual(STRANGER, 'Theirs');
    await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));

    const theirs = await json(await memoryGet(request(STRANGER, '/api/mobile/memory')));
    assert.deepEqual(theirs.items.map((i: any) => i.content), ['Theirs']);
  } finally {
    end();
  }
});

test('every memory and profile route refuses an unauthenticated caller', async () => {
  begin();
  try {
    const anonymous = (path: string, method = 'GET') =>
      new Request(`${baseUrl}${path}`, { method, headers: new Headers({ 'Content-Type': 'application/json' }), body: method === 'GET' ? undefined : '{}' });

    const responses = await Promise.all([
      profileGet(anonymous('/api/mobile/profile')),
      routinePut(anonymous('/api/mobile/profile/routine', 'PUT')),
      memoryGet(anonymous('/api/mobile/memory')),
      memoryPost(anonymous('/api/mobile/memory', 'POST')),
      memoryDeleteAll(anonymous('/api/mobile/memory', 'DELETE')),
      memoryPatch(anonymous('/api/mobile/memory/mem_x', 'PATCH'), params('mem_x')),
      memoryDelete(anonymous('/api/mobile/memory/mem_x', 'DELETE'), params('mem_x')),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 401, 'an anonymous caller was not refused');
    }
  } finally {
    end();
  }
});

// ── The feature flag ─────────────────────────────────────────────

test('with the memory feature off every route is a 404 and nothing is written', async () => {
  begin('false');
  try {
    const responses = await Promise.all([
      profileGet(request(OWNER, '/api/mobile/profile')),
      routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' })),
      memoryGet(request(OWNER, '/api/mobile/memory')),
      memoryPost(request(OWNER, '/api/mobile/memory', { body: { kind: 'fact', content: 'x', language: 'en' } })),
      memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' })),
    ]);
    for (const response of responses) assert.equal(response.status, 404);
    assert.deepEqual(await createStorageRuntimeMemoryStore().listAll(OWNER), []);
  } finally {
    end();
  }
});

test('deploy readiness for staging: a goal, the memory list, and the routine survey all succeed with the flag on', async () => {
  // Evidence gate for the L1 infra lane (#167 staging rollout, 2026-09-25):
  // before `MAYBESITTER_FEATURE_MEMORY=true` reaches a real deployment, this
  // pins the exact trio the deploy depends on actually working with the flag
  // on, in one flow, rather than trusting that scattered single-purpose tests
  // above add up to the same guarantee.
  begin('true');
  try {
    const created = await memoryPost(request(OWNER, '/api/mobile/memory', {
      body: { kind: 'goal', content: 'Finish the thesis', language: 'en' },
    }));
    assert.equal(created.status, 201, 'POST /api/mobile/memory kind "goal" did not succeed with the flag on');

    const listed = await memoryGet(request(OWNER, '/api/mobile/memory'));
    assert.equal(listed.status, 200, 'GET /api/mobile/memory did not succeed with the flag on');
    assert.equal((await json(listed)).items.length, 1);

    const routine = await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));
    assert.equal(routine.status, 200, 'PUT /api/mobile/profile/routine did not succeed with the flag on');
  } finally {
    end();
  }
});

test('the kill switch closes the routes even with the feature flag on', async () => {
  begin('true');
  const previousKill = process.env.MAYBESITTER_KILL_SWITCH_MEMORY;
  process.env.MAYBESITTER_KILL_SWITCH_MEMORY = 'true';
  try {
    assert.equal((await memoryGet(request(OWNER, '/api/mobile/memory'))).status, 404);
  } finally {
    if (previousKill === undefined) delete process.env.MAYBESITTER_KILL_SWITCH_MEMORY;
    else process.env.MAYBESITTER_KILL_SWITCH_MEMORY = previousKill;
    end();
  }
});

// ── Account deletion ─────────────────────────────────────────────

test('routine facts and the profile live where account deletion already reaches', async () => {
  begin();
  try {
    await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));

    // The end-to-end proof is tests/storage/deletionCoverageSuite.ts, which is
    // driven by USER_SCOPED_COLLECTIONS. What is pinned here is the premise
    // that suite relies on: #167 writes to exactly two places, and both are
    // inside `users/{uid}`, so `deleteTree(users/U)` already reaches them.
    assert.ok(
      (USER_SCOPED_COLLECTIONS as readonly string[]).includes(MEMORY),
      'memory is not in the set account deletion walks',
    );

    const storage = getStorage();
    const user = await storage.get<{ profile?: { routine?: unknown } }>(userDoc(OWNER));
    assert.ok(user?.profile?.routine, 'the routine profile is not on the user document');

    const stray = (await storage.listGroup<{ scopeId?: string }>(MEMORY))
      .filter((row) => !row.path.startsWith(`${userDoc(OWNER)}/`));
    assert.deepEqual(stray, [], 'a routine fact was written outside the user tree');
  } finally {
    end();
  }
});

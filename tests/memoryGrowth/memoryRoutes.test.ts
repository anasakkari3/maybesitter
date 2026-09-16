/**
 * Deterministic memory growth through the routes (UC-3.16, #202).
 *
 * Every claim here is checked against storage, not against what the route
 * said about itself: that a GET wrote nothing is a count of writes the adapter
 * saw; that Keep saved a rule-derived record is a read of that record; that a
 * delete removed it is a read after the delete and an export.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { StorageAdapter, StorageTransaction } from '../../lib/storage/storageAdapter.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import { setPersonalizationConsent } from '../../lib/consents/personalizationConsentService.ts';
import { PERSONALIZATION_CONSENT_VERSION } from '../../src/contracts/v1/consentContracts.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import {
  DELETE as memoryDeleteAll,
  GET as memoryGet,
} from '../../src/app/api/mobile/memory/route.ts';
import { DELETE as memoryDelete, PATCH as memoryPatch } from '../../src/app/api/mobile/memory/[id]/route.ts';
import { POST as suggestionPost } from '../../src/app/api/mobile/memory/suggestions/[ruleId]/route.ts';
import { EVENTS, MEMORY, MEMORY_DISMISSALS, userCol, userDoc, userSubDoc } from '../../lib/storage/paths.ts';
import { KEPT_SUGGESTION_CONTENT } from '../../lib/memoryGrowth/templates.ts';
import { GROWTH_EVENT_READ_LIMIT } from '../../lib/memoryGrowth/suggestionService.ts';
import { deleteAllMemory } from '../../lib/services/mobile/memoryService.ts';
import { listAuditEvents } from '../../lib/pilot/pilotTrustStore.ts';

const baseUrl = 'http://127.0.0.1:4321';
const OWNER = uidFor('GrowthOwner');
const STRANGER = uidFor('GrowthStranger');
const ZONE = 'Asia/Jerusalem';
/** The routes read the wall clock, so the fixture is laid out relative to it. */
const NOW_MS = Date.now();

let auth: FakeAuthControls | null = null;
let previousFlag: string | undefined;

function begin(storage: StorageAdapter = createMemoryStorage()): StorageAdapter {
  auth = installFakeAuth();
  setStorageForTests(storage);
  previousFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
  process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
  return storage;
}

function end(): void {
  if (previousFlag === undefined) delete process.env.MAYBESITTER_FEATURE_MEMORY;
  else process.env.MAYBESITTER_FEATURE_MEMORY = previousFlag;
  resetStorageForTests();
  auth?.restore();
  auth = null;
}

function request(uid: string | null, path: string, options: { body?: unknown; method?: string } = {}): Request {
  const headers = new Headers();
  if (uid) headers.set('authorization', `Bearer ${tokenFor(uid)}`);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const ruleParams = (ruleId: string) => ({ params: Promise.resolve({ ruleId }) });

/**
 * An instant `daysAgo` days back at a local wall-clock time in Jerusalem.
 *
 * Built by searching for the UTC hour that reads as the wanted local hour,
 * rather than by assuming an offset, so the fixture holds whatever month the
 * suite runs in.
 */
function localInstant(daysAgo: number, hour: number, minute: number): string {
  const base = new Date(NOW_MS - daysAgo * 86_400_000);
  for (let utcHour = -14; utcHour <= 14; utcHour += 1) {
    const candidate = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), hour - utcHour, minute));
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(candidate);
    const h = Number(parts.find((part) => part.type === 'hour')!.value);
    if (h === hour && candidate.getTime() < NOW_MS) return candidate.toISOString();
  }
  throw new Error('no instant found');
}

async function seedCompletion(uid: string, id: string, at: string, commitmentId = `c_${id}`): Promise<void> {
  await getStorage().set(userSubDoc(uid, EVENTS, id), {
    id, type: 'commitment_completed', at, aggregateId: commitmentId, payload: {},
  });
}

/** Ten distinct things finished: seven between 09:00 and 12:00 local. */
async function seedMorningHabit(uid: string, hourShift = 0): Promise<void> {
  await getStorage().set(userDoc(uid), { uid, timezone: ZONE });
  const morning: Array<[number, number, number]> = [
    [1, 9, 15], [2, 9, 40], [3, 10, 0], [5, 10, 30], [6, 11, 0], [8, 11, 20], [9, 11, 45],
  ];
  for (let index = 0; index < morning.length; index += 1) {
    const [daysAgo, hour, minute] = morning[index]!;
    await seedCompletion(uid, `ev_m${index}`, localInstant(daysAgo, hour + hourShift, minute));
  }
  const evening: Array<[number, number]> = [[4, 19], [7, 20], [10, 21]];
  for (let index = 0; index < evening.length; index += 1) {
    const [daysAgo, hour] = evening[index]!;
    await seedCompletion(uid, `ev_e${index}`, localInstant(daysAgo, hour, 5));
  }
  // Noise the rule must not read: not a completion, and a stranger's.
  await getStorage().set(userSubDoc(uid, EVENTS, 'ev_noise'), {
    id: 'ev_noise', type: 'commitment_postponed', at: localInstant(2, 10, 10), aggregateId: 'c_x', payload: {},
  });
}

/** Answered the way the phone answers it: the versioned record and the store. */
async function enableConsent(uid: string): Promise<void> {
  await setPersonalizationConsent(uid, {
    state: 'granted',
    version: PERSONALIZATION_CONSENT_VERSION,
    at: new Date(NOW_MS - 60_000),
  });
}

/** Wraps an adapter and counts every write it is asked to make. */
function countingWrites(inner: StorageAdapter): { storage: StorageAdapter; writes: () => number } {
  let writes = 0;
  const storage: StorageAdapter = {
    get: (path) => inner.get(path),
    list: (path, options) => inner.list(path, options),
    listGroup: (id, options) => inner.listGroup(id, options),
    async set(path, value) { writes += 1; return inner.set(path, value); },
    async delete(path) { writes += 1; return inner.delete(path); },
    async deleteTree(path) { writes += 1; return inner.deleteTree(path); },
    runTransaction(fn) {
      return inner.runTransaction((tx) => fn({
        get: (path) => tx.get(path),
        list: (path, options) => tx.list(path, options),
        listGroup: (id, options) => tx.listGroup(id, options),
        set(path, value) { writes += 1; tx.set(path, value); },
        merge(path, value) { writes += 1; tx.merge(path, value); },
        create(path, value) { writes += 1; tx.create(path, value); },
        delete(path) { writes += 1; tx.delete(path); },
      } as StorageTransaction));
    },
  };
  return { storage, writes: () => writes };
}

/**
 * The first authenticated request creates the account's pilot trust record —
 * a write that belongs to authentication, not to memory. It is made before
 * counting, and before consent, so it cannot compute a suggestion either.
 */
async function warmUpAuth(uid: string): Promise<void> {
  await memoryGet(request(uid, '/api/mobile/memory'));
}

async function suggestionsFor(uid: string): Promise<Array<Record<string, any>>> {
  const body = await json(await memoryGet(request(uid, '/api/mobile/memory')));
  return body.suggestions as Array<Record<string, any>>;
}

async function keep(uid: string, fingerprint: string, language = 'en'): Promise<Response> {
  return suggestionPost(
    request(uid, '/api/mobile/memory/suggestions/R1_focus_window', { body: { decision: 'keep', fingerprint, language } }),
    ruleParams('R1_focus_window'),
  );
}

async function dismiss(uid: string, fingerprint: string): Promise<Response> {
  return suggestionPost(
    request(uid, '/api/mobile/memory/suggestions/R1_focus_window', { body: { decision: 'dismiss', fingerprint } }),
    ruleParams('R1_focus_window'),
  );
}

// ── Suggested on read, never saved by reading ────────────────────

test('the issue’s fixture yields the R1 suggestion, with counts and no evidence ids', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const body = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    assert.deepEqual(body.items, []);
    assert.equal(body.suggestions.length, 1);
    assert.deepEqual(body.suggestions[0], {
      ruleId: 'R1_focus_window',
      fingerprint: 'R1_focus_window:09:00-12:00',
      window: { start: '09:00', end: '12:00' },
      confidence: 0.7,
      evidence: { matchingCount: 7, totalCount: 10, lookbackDays: 28 },
    });
  } finally {
    end();
  }
});

test('reading suggestions writes nothing anywhere', async () => {
  const { storage, writes } = countingWrites(createMemoryStorage());
  begin(storage);
  try {
    await seedMorningHabit(OWNER);
    await warmUpAuth(OWNER);
    await enableConsent(OWNER);
    const before = writes();
    const suggestions = await suggestionsFor(OWNER);
    assert.equal(suggestions.length, 1, 'no suggestion was computed, so a zero write count would prove nothing');
    await suggestionsFor(OWNER);
    assert.equal(writes() - before, 0);
    assert.equal((await createStorageRuntimeMemoryStore().listAll(OWNER)).length, 0);
    assert.equal((await storage.list(userCol(OWNER, MEMORY_DISMISSALS))).length, 0);
  } finally {
    end();
  }
});

test('with personalization consent off there are no suggestions, and Keep is refused', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    // Never asked.
    assert.deepEqual(await suggestionsFor(OWNER), []);
    // Asked and declined.
    await createStoragePersonalizationConsentStore().write(OWNER, 'disabled', new Date(NOW_MS - 1000).toISOString());
    assert.deepEqual(await suggestionsFor(OWNER), []);

    const refused = await keep(OWNER, 'R1_focus_window:09:00-12:00');
    assert.equal(refused.status, 403);
    assert.equal((await json(refused)).reason, 'personalization_consent_required');
    // Dismiss too: without consent nothing about this account's patterns is
    // written, not even that one was turned down.
    const refusedDismiss = await dismiss(OWNER, 'R1_focus_window:09:00-12:00');
    assert.equal(refusedDismiss.status, 403);
    assert.equal((await json(refusedDismiss)).reason, 'personalization_consent_required');
    assert.equal((await getStorage().list(userCol(OWNER, MEMORY_DISMISSALS))).length, 0);
    assert.equal((await createStorageRuntimeMemoryStore().listAll(OWNER)).length, 0);
  } finally {
    end();
  }
});

test('one account’s completions never become another account’s suggestion', async () => {
  begin();
  try {
    await seedMorningHabit(STRANGER);
    await getStorage().set(userDoc(OWNER), { uid: OWNER, timezone: ZONE });
    await enableConsent(OWNER);
    await enableConsent(STRANGER);
    assert.equal((await suggestionsFor(STRANGER)).length, 1);
    assert.deepEqual(await suggestionsFor(OWNER), []);
  } finally {
    end();
  }
});

// ── Keep ──────────────────────────────────────────────────────────

test('Keep stores a rule-derived preference, and it lists instead of being suggested', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const response = await keep(OWNER, 'R1_focus_window:09:00-12:00', 'ar');
    assert.equal(response.status, 201);
    const kept = (await json(response)).memory;
    assert.equal(kept.source, 'deterministic_rule');
    assert.equal(kept.sourceLabel, 'noticed_from_confirmed');
    assert.equal(kept.kind, 'preference');
    assert.equal(kept.language, 'ar');
    assert.equal(kept.content, KEPT_SUGGESTION_CONTENT.ar.replace('{start}', '09:00').replace('{end}', '12:00'));
    assert.equal(kept.confidence, 0.7);
    assert.equal(kept.evidence.origin, 'behaviour_rule');
    assert.equal(kept.evidence.observationCount, 7);
    assert.deepEqual(kept.evidence.pattern, { ruleId: 'R1_focus_window', window: { start: '09:00', end: '12:00' } });

    // From the store, not the response.
    const stored = await createStorageRuntimeMemoryStore().get(kept.id);
    assert.ok(stored);
    assert.equal(stored.scopeId, OWNER);
    assert.equal(stored.exportPolicy, 'personal_never_export');
    assert.equal(stored.source, 'deterministic_rule');
    assert.equal(stored.evidenceIds.length, 7);
    assert.ok(stored.evidenceIds.every((id) => id.startsWith('ev_m')), 'an evening completion was filed as evidence');
    assert.equal(stored.provenance?.originRef, 'R1_focus_window:09:00-12:00');
    assert.ok(stored.provenance?.confirmedByUserAt, 'a kept suggestion records that the user kept it');

    const body = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    assert.deepEqual(body.items.map((item: { id: string }) => item.id), [kept.id]);
    assert.deepEqual(body.suggestions, []);
  } finally {
    end();
  }
});

test('Keep recomputes: a fingerprint the server no longer suggests is refused and nothing is written', async () => {
  const { storage, writes } = countingWrites(createMemoryStorage());
  begin(storage);
  try {
    await seedMorningHabit(OWNER);
    await warmUpAuth(OWNER);
    await enableConsent(OWNER);
    const before = writes();
    for (const fingerprint of ['R1_focus_window:14:00-17:00', 'R1_focus_window:09:30-12:30', '']) {
      const response = await keep(OWNER, fingerprint);
      assert.equal(response.status, 409, fingerprint);
      assert.equal((await json(response)).reason, 'memory_suggestion_stale');
    }
    assert.equal(writes() - before, 0);
  } finally {
    end();
  }
});

test('the body cannot choose what is stored: content, confidence and source come from the rule', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const response = await suggestionPost(
      request(OWNER, '/api/mobile/memory/suggestions/R1_focus_window', {
        body: {
          decision: 'keep',
          fingerprint: 'R1_focus_window:09:00-12:00',
          language: 'en',
          content: 'I am lazy in the afternoon',
          confidence: 1,
          source: 'user_stated',
          evidenceIds: ['forged'],
        },
      }),
      ruleParams('R1_focus_window'),
    );
    const kept = (await json(response)).memory;
    assert.equal(kept.content, 'You often finish things between 09:00 and 12:00.');
    assert.equal(kept.confidence, 0.7);
    assert.equal(kept.source, 'deterministic_rule');
    const stored = await createStorageRuntimeMemoryStore().get(kept.id);
    assert.ok(!stored?.evidenceIds.includes('forged'));
  } finally {
    end();
  }
});

test('a malformed decision is refused, an unknown rule is a 404, and nobody unauthenticated gets in', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const badDecision = await suggestionPost(
      request(OWNER, '/api/mobile/memory/suggestions/R1_focus_window', { body: { decision: 'maybe', fingerprint: 'x' } }),
      ruleParams('R1_focus_window'),
    );
    assert.equal(badDecision.status, 400);
    const badLanguage = await keep(OWNER, 'R1_focus_window:09:00-12:00', 'fr');
    assert.equal(badLanguage.status, 400);
    const unknownRule = await suggestionPost(
      request(OWNER, '/api/mobile/memory/suggestions/R2_defer_default', { body: { decision: 'dismiss', fingerprint: 'x' } }),
      ruleParams('R2_defer_default'),
    );
    assert.equal(unknownRule.status, 404);
    const anonymous = await suggestionPost(
      request(null, '/api/mobile/memory/suggestions/R1_focus_window', { body: { decision: 'dismiss', fingerprint: 'x' } }),
      ruleParams('R1_focus_window'),
    );
    assert.equal(anonymous.status, 401);
    assert.equal((await createStorageRuntimeMemoryStore().listAll(OWNER)).length, 0);
  } finally {
    end();
  }
});

// ── Dismiss ───────────────────────────────────────────────────────

test('Dismiss stops the same fingerprint reappearing, and a different one still can', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const response = await dismiss(OWNER, 'R1_focus_window:09:00-12:00');
    assert.equal(response.status, 200);
    assert.deepEqual(await suggestionsFor(OWNER), []);
    assert.deepEqual(await suggestionsFor(OWNER), [], 'a dismissal that wore off on the second read');
    assert.equal((await createStorageRuntimeMemoryStore().listAll(OWNER)).length, 0, 'a dismissal wrote a memory');

    // The habit moves to the afternoon: a different claim, so it may be suggested.
    await getStorage().deleteTree(userDoc(OWNER));
    await seedMorningHabit(OWNER, 4);
    await enableConsent(OWNER);
    await dismiss(OWNER, 'R1_focus_window:09:00-12:00');
    const moved = await suggestionsFor(OWNER);
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.fingerprint, 'R1_focus_window:13:00-16:00');
  } finally {
    end();
  }
});

test('one account’s dismissal does not silence another’s suggestion', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await seedMorningHabit(STRANGER);
    await enableConsent(OWNER);
    await enableConsent(STRANGER);
    await dismiss(STRANGER, 'R1_focus_window:09:00-12:00');
    assert.equal((await suggestionsFor(OWNER)).length, 1);
    assert.deepEqual(await suggestionsFor(STRANGER), []);
  } finally {
    end();
  }
});

// ── Edit and delete, against storage ─────────────────────────────

test('editing a kept suggestion makes it the user’s sentence and the old record stops listing', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const kept = (await json(await keep(OWNER, 'R1_focus_window:09:00-12:00'))).memory;
    const patched = await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${kept.id}`, { body: { content: 'Mornings are when I get things done' }, method: 'PATCH' }),
      idParams(kept.id),
    ));
    assert.equal(patched.memory.source, 'user_stated');
    assert.equal(patched.memory.sourceLabel, 'you_told_us');
    assert.equal(patched.memory.evidence.pattern, null, 'the user’s own sentence is not a rule’s window any more');

    const body = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    assert.deepEqual(body.items.map((item: { id: string }) => item.id), [patched.memory.id]);
    // The pattern was already answered — in the user’s own words — so it is not asked again.
    assert.deepEqual(body.suggestions, []);
    const old = await createStorageRuntimeMemoryStore().get(kept.id);
    assert.equal(old?.status, 'superseded');
  } finally {
    end();
  }
});

test('deleting a kept suggestion removes it from storage and from export, and does not re-suggest it', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    const kept = (await json(await keep(OWNER, 'R1_focus_window:09:00-12:00'))).memory;
    const store = createStorageRuntimeMemoryStore();
    assert.ok(await store.get(kept.id));
    assert.equal((await store.export(OWNER, new Date(NOW_MS).toISOString())).records.length, 1);

    const response = await memoryDelete(
      request(OWNER, `/api/mobile/memory/${kept.id}`, { method: 'DELETE' }),
      idParams(kept.id),
    );
    assert.equal(response.status, 200);

    assert.equal(await store.get(kept.id), null);
    assert.equal(await getStorage().get(userSubDoc(OWNER, MEMORY, kept.id)), null);
    assert.equal((await store.export(OWNER, new Date(NOW_MS).toISOString())).records.length, 0);
    // "Forget that" is not answered by offering the same sentence back on the next read.
    assert.deepEqual(await suggestionsFor(OWNER), []);
  } finally {
    end();
  }
});

test('a user-typed fact deleted by id is gone from storage and from export too', async () => {
  begin();
  try {
    const store = createStorageRuntimeMemoryStore();
    const record = await store.put({
      scopeId: OWNER, kind: 'fact', content: 'I work Sundays', language: 'en', source: 'user_stated',
      confidence: 1, observedAt: new Date(NOW_MS).toISOString(), provenance: { origin: 'manual' },
    }, new Date(NOW_MS).toISOString());
    await memoryDelete(request(OWNER, `/api/mobile/memory/${record.id}`, { method: 'DELETE' }), idParams(record.id));
    assert.equal(await store.get(record.id), null);
    assert.deepEqual((await store.export(OWNER, new Date(NOW_MS).toISOString())).records, []);
    // Deleting a fact nobody's rule produced writes no dismissal.
    assert.equal((await getStorage().list(userCol(OWNER, MEMORY_DISMISSALS))).length, 0);
  } finally {
    end();
  }
});

test('a record written before provenance existed still lists, with no pattern', async () => {
  begin();
  try {
    const at = new Date(NOW_MS - 86_400_000).toISOString();
    await getStorage().set(userSubDoc(OWNER, MEMORY, 'mem_legacy'), {
      version: 'runtime-memory-v1', id: 'mem_legacy', scopeId: OWNER, kind: 'preference',
      content: 'Prefers mornings', language: 'en', source: 'user_stated', confidence: 1,
      exportPolicy: 'personal_never_export', status: 'active', createdAt: at, updatedAt: at,
      observedAt: at, staleAfter: new Date(NOW_MS + 86_400_000 * 365).toISOString(), evidenceIds: [],
    });
    const body = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].evidence.origin, null);
    assert.equal(body.items[0].evidence.pattern, null);
  } finally {
    end();
  }
});

test('"delete everything" leaves zero memory, zero dismissals and zero personalization rows', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    await keep(OWNER, 'R1_focus_window:09:00-12:00');
    await getStorage().set(userSubDoc(OWNER, MEMORY_DISMISSALS, 'R1_focus_window'), {
      ruleId: 'R1_focus_window', fingerprint: 'R1_focus_window:13:00-16:00', dismissedAt: new Date(NOW_MS).toISOString(),
    });
    await createStorageFeedbackEventStore().append({
      scopeId: OWNER, outcome: 'accept', subjectId: 's1', actor: 'user', source: 'mobile_action',
      occurredAt: new Date(NOW_MS).toISOString(),
    }, new Date(NOW_MS).toISOString());

    const response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    assert.equal(response.status, 200);

    assert.equal((await createStorageRuntimeMemoryStore().listAll(OWNER)).length, 0);
    assert.equal((await getStorage().list(userCol(OWNER, MEMORY_DISMISSALS))).length, 0);
    assert.equal((await createStorageFeedbackEventStore().list({ scopeId: OWNER })).length, 0);
    // The completions are the user's own history and stay; the suggestion is
    // computed again, because nothing about it was ever saved.
    assert.equal((await suggestionsFor(OWNER)).length, 1);
  } finally {
    end();
  }
});

test('a log too large to read whole yields no suggestion rather than one skewed toward old habits', async () => {
  begin();
  try {
    await seedMorningHabit(OWNER);
    await enableConsent(OWNER);
    assert.equal((await suggestionsFor(OWNER)).length, 1);
    // Fill the 28 days to the read bound with events that are not completions.
    const at = localInstant(3, 14, 0);
    for (let index = 0; index < GROWTH_EVENT_READ_LIMIT; index += 1) {
      await getStorage().set(userSubDoc(OWNER, EVENTS, `ev_bulk_${index}`), {
        id: `ev_bulk_${index}`, type: 'draft_created', at, aggregateId: `c_bulk_${index}`, payload: {},
      });
    }
    assert.deepEqual(await suggestionsFor(OWNER), []);
  } finally {
    end();
  }
});

test('a dismissal left behind is a failed deletion, not a 200', async () => {
  begin();
  try {
    await getStorage().set(userSubDoc(OWNER, MEMORY_DISMISSALS, 'R1_focus_window'), {
      ruleId: 'R1_focus_window', fingerprint: 'R1_focus_window:09:00-12:00', dismissedAt: new Date(NOW_MS).toISOString(),
    });
    const storage = getStorage();
    const real = storage.delete.bind(storage);
    (storage as { delete: unknown }).delete = async (path: string) => {
      if (path.includes(`/${MEMORY_DISMISSALS}/`)) return;
      await real(path);
    };
    let response: Response;
    try {
      response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    } finally {
      (storage as { delete: unknown }).delete = real;
    }
    assert.equal(response.status, 500);
    assert.equal((await json(response)).reason, 'memory_delete_incomplete');
    assert.deepEqual((await listAuditEvents(OWNER)).filter((event) => event.eventType === 'memory_deleted'), []);
  } finally {
    end();
  }
});

test('delete-all purges dismissals from the storage it was handed, not the process default', async () => {
  begin();
  try {
    const injected = createMemoryStorage();
    await injected.set(userSubDoc(OWNER, MEMORY_DISMISSALS, 'R1_focus_window'), {
      ruleId: 'R1_focus_window', fingerprint: 'R1_focus_window:09:00-12:00', dismissedAt: new Date(NOW_MS).toISOString(),
    });
    await deleteAllMemory(OWNER, new Date(NOW_MS).toISOString(), {
      storage: injected,
      memory: createStorageRuntimeMemoryStore(undefined, injected),
      feedback: createStorageFeedbackEventStore(injected),
    });
    assert.equal((await injected.list(userCol(OWNER, MEMORY_DISMISSALS))).length, 0);
  } finally {
    end();
  }
});

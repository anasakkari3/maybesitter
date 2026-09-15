/**
 * Provenance, evidence, and the delete cascade (UC-3.16, #202).
 *
 * This file covers the half of #202 that is executable today: what
 * `GET /api/mobile/memory` says about where a fact came from, that an edit is
 * a supersession rather than a rewrite, that memory CRUD is not gated on
 * personalization consent, and — the defect it was written for — that "delete
 * everything" reaches the derived profile's inputs and not only the memory
 * rows.
 *
 * ── The cascade test is the reason this file exists ──────────────
 *
 * Before #202, `DELETE /api/mobile/memory` called `store.deleteScope(uid)` and
 * stopped there. `deletePersonalizationScope` existed and had two callers, both
 * on the frozen web surface. So a user on the phone who asked MaybeSitter to
 * forget everything got a receipt that said `success: true`, an empty memory
 * screen — and kept every feedback event the behaviour profile is derived
 * from. The screen said the deletion happened; the store disagreed.
 *
 * `delete-all leaves no personalization row behind` is written from the store's
 * side, not the route's: it re-lists the feedback events afterwards rather than
 * trusting the `deleted` count the route reported, because the one failure this
 * must catch is exactly a route that reports a number and leaves rows.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { getStorage, resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { createStorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createStorageRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { createStoragePersonalizationConsentStore } from '../../lib/personalizationControls/consentStore.ts';
import {
  DELETE as memoryDeleteAll,
  GET as memoryGet,
  POST as memoryPost,
} from '../../src/app/api/mobile/memory/route.ts';
import { PATCH as memoryPatch } from '../../src/app/api/mobile/memory/[id]/route.ts';
import { PUT as routinePut } from '../../src/app/api/mobile/profile/routine/route.ts';
import { listAuditEvents } from '../../lib/pilot/pilotTrustStore.ts';
import { BEHAVIOR_FEEDBACK, FEEDBACK_BASELINES, MEMORY, PROFILE_PROPOSALS, userCol } from '../../lib/storage/paths.ts';
import {
  createDefaultBehaviorFeedbackStore,
  recordBehaviorFeedback,
  scopeBehaviorFeedback,
} from '../../lib/services/behaviorFeedbackService.ts';
import { getAdaptiveBehaviorFromState } from '../../lib/services/adaptiveService.ts';
import type { DomainState } from '../../src/domain/stateMachine.ts';
import { FEEDBACK_EVENT_SCHEMA_VERSION, type FeedbackBaseline } from '../../src/contracts/v1/feedbackContracts.ts';
import { DEFAULT_MEMORY_TTL_MS, USER_STATED_MEMORY_TTL_MS } from '../../src/contracts/v1/memoryContracts.ts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = 'http://127.0.0.1:4321';
const OWNER = uidFor('ProvenanceOwner');
const NOW = '2026-09-14T09:00:00.000Z';

let auth: FakeAuthControls | null = null;
let previousFlag: string | undefined;

function begin(): void {
  auth = installFakeAuth();
  setStorageForTests(createMemoryStorage());
  previousFlag = process.env.MAYBESITTER_FEATURE_MEMORY;
  process.env.MAYBESITTER_FEATURE_MEMORY = 'true';
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

/** Three behaviour rows for the uid — the inputs the profile is derived from. */
async function seedPersonalizationRows(uid: string): Promise<number> {
  const feedback = createStorageFeedbackEventStore();
  // Distinct subjectIds: the store derives its idempotency key from
  // (scopeId, subjectId, outcome, occurredAt), so identical rows collapse to
  // one and a deletion that removes almost nothing would still look complete.
  for (const subjectId of ['prop-1', 'prop-2', 'prop-3']) {
    await feedback.append({
      scopeId: uid,
      outcome: 'accept',
      subjectId,
      actor: 'user',
      source: 'mobile_action',
      occurredAt: NOW,
    }, NOW);
  }
  return (await feedback.list({ scopeId: uid })).length;
}

/**
 * The legacy counters carried over from before the event log existed.
 *
 * It is history of the same person and is not an event, so it is outside the
 * receipt's `remainingFeedbackEventCount` — which is exactly why a delete-all
 * that reads only that number would leave it behind.
 */
function legacyBaseline(uid: string): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId: uid,
    counters: {
      ignoredSuggestions: 4,
      completedActions: 11,
      delayedActions: 2,
      clarificationSuccesses: 3,
      clarificationFailures: 1,
    },
    lastUpdatedAt: '2026-08-01T00:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: '2026-08-02T00:00:00.000Z',
  };
}

/** The state the classifier reads alongside the counters; empty on purpose. */
const NO_COMMITMENTS: DomainState = { commitments: {}, reminders: {}, escalationStates: {} };

/**
 * The legacy per-action counters, written through the same call the product
 * uses (`agendaActionService` and `captureService` both go through
 * `recordBehaviorFeedback`).
 *
 * These are the direct input to `adaptiveService`, the shipped classifier that
 * labels a person avoidant / inconsistent / disciplined. They live in a store
 * `deletePersonalizationScope` did not touch.
 */
async function seedBehaviorCounters(uid: string): Promise<void> {
  for (const event of ['suggestion_ignored', 'suggestion_ignored', 'suggestion_ignored', 'action_delayed'] as const) {
    await recordBehaviorFeedback(event, { userId: uid, now: new Date(NOW) });
  }
}

async function behaviorCountersFor(uid: string) {
  return await createDefaultBehaviorFeedbackStore().get(scopeBehaviorFeedback({ userId: uid }));
}

/** A pending self-description proposal, which can be confirmed into memory. */
async function seedProfileProposal(uid: string): Promise<void> {
  await getStorage().set(`${userCol(uid, PROFILE_PROPOSALS)}/prop_pending`, {
    proposalId: 'prop_pending',
    suggestions: [{ kind: 'fact', content: 'I get anxious about deadlines', language: 'en' }],
    createdAt: NOW,
    promptVersion: 'v1',
    model: 'test-model',
  });
}

// ── The delete cascade ───────────────────────────────────────────

test('delete-all leaves no personalization row behind', async () => {
  begin();
  try {
    await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));
    assert.equal(await seedPersonalizationRows(OWNER), 3, 'the fixture did not seed three behaviour rows');

    const response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    assert.equal(response.status, 200);
    assert.equal((await json(response)).success, true);

    // Re-listed from the stores, never subtracted from what the route claimed.
    const memory = createStorageRuntimeMemoryStore();
    const feedback = createStorageFeedbackEventStore();
    assert.deepEqual(await memory.listAll(OWNER), [], 'a memory record survived delete-all');
    assert.deepEqual(
      await feedback.list({ scopeId: OWNER }),
      [],
      'a personalization row survived delete-all: the user was told they were forgotten and was not',
    );
  } finally {
    end();
  }
});

test('delete-all deletes only the caller’s personalization rows', async () => {
  begin();
  const stranger = uidFor('ProvenanceStranger');
  try {
    await seedPersonalizationRows(OWNER);
    await seedPersonalizationRows(stranger);

    await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));

    const feedback = createStorageFeedbackEventStore();
    assert.equal((await feedback.list({ scopeId: OWNER })).length, 0);
    assert.equal((await feedback.list({ scopeId: stranger })).length, 3);
  } finally {
    end();
  }
});

test('delete-all keeps the consent decision, which is the user’s and not derived', async () => {
  begin();
  try {
    const consent = createStoragePersonalizationConsentStore();
    await consent.write(OWNER, 'enabled', NOW);
    await seedPersonalizationRows(OWNER);

    await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));

    // Erasing it would silently opt the user back out of a choice they made,
    // and the next screen would ask them a question they had already answered.
    assert.equal((await consent.read(OWNER)).state, 'enabled');
  } finally {
    end();
  }
});

test('a delete that cannot finish is reported as a failure, not audited as a success', async () => {
  begin();
  try {
    await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));
    await seedPersonalizationRows(OWNER);

    // A store that reports a count and leaves the rows exactly where they were
    // — the failure the remainder check exists to catch. `deleteScope` counts
    // the rows it listed, so silencing the per-document delete makes it return
    // a plausible number while nothing moves.
    const storage = getStorage();
    const real = storage.delete.bind(storage);
    (storage as { delete: unknown }).delete = async (path: string) => {
      if (path.includes(`/${MEMORY}/`)) return;
      await real(path);
    };

    let response: Response;
    try {
      response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    } finally {
      (storage as { delete: unknown }).delete = real;
    }

    assert.equal(response.status, 500);
    assert.equal((await json(response)).success, false);

    const audited = (await listAuditEvents(OWNER))
      .filter((event) => event.eventType === 'memory_deleted');
    assert.deepEqual(audited, [], 'a deletion that left rows behind was written into the audit log as done');

    // And the rows really are still there, so the 500 is the truth.
    assert.ok((await createStorageRuntimeMemoryStore().listAll(OWNER)).length > 0);
  } finally {
    end();
  }
});

test('delete-all removes the pre-event-log baseline as well as the events', async () => {
  begin();
  try {
    const feedback = createStorageFeedbackEventStore();
    await feedback.writeBaseline(legacyBaseline(OWNER));
    await seedPersonalizationRows(OWNER);
    assert.notEqual(await feedback.readBaseline(OWNER), null, 'the fixture did not write a baseline');

    const response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    assert.equal(response.status, 200);

    assert.equal(
      await createStorageFeedbackEventStore().readBaseline(OWNER),
      null,
      'the legacy counters survived delete-all: the derived profile still has inputs',
    );
  } finally {
    end();
  }
});

test('a baseline left behind is a failed deletion, not a 200 with a footnote', async () => {
  begin();
  try {
    const feedback = createStorageFeedbackEventStore();
    await feedback.writeBaseline(legacyBaseline(OWNER));
    await seedPersonalizationRows(OWNER);

    // The baseline is not an event, so a remainder check that counted only
    // events would call this deletion finished. Silencing the one document's
    // delete is the smallest way to produce exactly that state.
    const storage = getStorage();
    const real = storage.delete.bind(storage);
    (storage as { delete: unknown }).delete = async (path: string) => {
      if (path.includes(`/${FEEDBACK_BASELINES}/`)) return;
      await real(path);
    };

    let response: Response;
    try {
      response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    } finally {
      (storage as { delete: unknown }).delete = real;
    }

    assert.equal(response.status, 500, 'a surviving baseline was reported to the user as a completed deletion');
    assert.equal((await json(response)).reason, 'memory_delete_incomplete');
    assert.deepEqual(
      (await listAuditEvents(OWNER)).filter((event) => event.eventType === 'memory_deleted'),
      [],
    );
    assert.notEqual(await createStorageFeedbackEventStore().readBaseline(OWNER), null);
  } finally {
    end();
  }
});


test('delete-all clears the legacy behaviour counters the classifier reads', async () => {
  begin();
  try {
    await seedBehaviorCounters(OWNER);
    const before = await behaviorCountersFor(OWNER);
    assert.equal(before.ignoredSuggestions, 3, 'the fixture did not seed the counters');

    // The label the shipped classifier puts on this person, before and after.
    const labelBefore = await getAdaptiveBehaviorFromState(NO_COMMITMENTS, { userId: OWNER });

    const response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    assert.equal(response.status, 200);

    const after = await behaviorCountersFor(OWNER);
    assert.deepEqual(
      [after.ignoredSuggestions, after.completedActions, after.delayedActions,
        after.clarificationSuccesses, after.clarificationFailures, after.updatedAt],
      [0, 0, 0, 0, 0, null],
      'the behaviour counters survived delete-all: the classifier still has its input',
    );

    // And the label really moves, which is the part the user can never check.
    const labelAfter = await getAdaptiveBehaviorFromState(NO_COMMITMENTS, { userId: OWNER });
    assert.notDeepEqual(
      labelAfter,
      labelBefore,
      'the derived label is byte-identical after "delete everything": nothing about the person was forgotten',
    );

    // Nothing of the document is left, not merely a zeroed copy of it.
    assert.deepEqual(await getStorage().list(userCol(OWNER, BEHAVIOR_FEEDBACK)), []);
  } finally {
    end();
  }
});

test('delete-all clears a pending self-description proposal, so nothing can be confirmed back afterwards', async () => {
  begin();
  try {
    await seedProfileProposal(OWNER);
    assert.equal((await getStorage().list(userCol(OWNER, PROFILE_PROPOSALS))).length, 1);

    const response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    assert.equal(response.status, 200);

    assert.deepEqual(
      await getStorage().list(userCol(OWNER, PROFILE_PROPOSALS)),
      [],
      'a pending proposal survived delete-all and could be confirmed into a fresh memory record',
    );
  } finally {
    end();
  }
});

test('delete-all leaves another account\u2019s behaviour counters alone', async () => {
  begin();
  const stranger = uidFor('ProvenanceStranger');
  try {
    await seedBehaviorCounters(OWNER);
    await seedBehaviorCounters(stranger);

    await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));

    assert.equal((await behaviorCountersFor(OWNER)).ignoredSuggestions, 0);
    assert.equal((await behaviorCountersFor(stranger)).ignoredSuggestions, 3);
  } finally {
    end();
  }
});

test('behaviour counters left behind are a failed deletion, not a 200', async () => {
  begin();
  try {
    await seedBehaviorCounters(OWNER);

    // A storage that swallows the one delete, leaving the counters exactly
    // where they were — the failure the remainder check exists to catch.
    const storage = getStorage();
    const real = storage.delete.bind(storage);
    (storage as { delete: unknown }).delete = async (path: string) => {
      if (path.includes(`/${BEHAVIOR_FEEDBACK}/`)) return;
      await real(path);
    };

    let response: Response;
    try {
      response = await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' }));
    } finally {
      (storage as { delete: unknown }).delete = real;
    }

    assert.equal(response.status, 500, 'surviving behaviour counters were reported as a completed deletion');
    assert.equal((await json(response)).reason, 'memory_delete_incomplete');
    assert.deepEqual(
      (await listAuditEvents(OWNER)).filter((event) => event.eventType === 'memory_deleted'),
      [],
    );
    assert.equal((await behaviorCountersFor(OWNER)).ignoredSuggestions, 3);
  } finally {
    end();
  }
});

// ── Provenance on the list ───────────────────────────────────────

test('every listed fact says where it came from, what backs it, and when it goes stale', async () => {
  begin();
  try {
    await routinePut(request(OWNER, '/api/mobile/profile/routine', { body: ROUTINE, method: 'PUT' }));
    const items = (await json(await memoryGet(request(OWNER, '/api/mobile/memory')))).items as any[];
    assert.ok(items.length > 0);

    for (const item of items) {
      // Not `you_told_us`: an onboarding answer is the user speaking, but the
      // screen names the path it came by, so they can recognise it.
      assert.equal(item.sourceLabel, 'you_answered_onboarding');
      assert.ok(Date.parse(item.staleAfter) > Date.parse(item.createdAt), 'staleAfter is not in the record’s future');
      assert.equal(item.evidence.origin, 'routine_survey');
      assert.equal(item.evidence.recordedAt, item.createdAt);
      assert.equal(item.evidence.observedAt, item.observedAt);
      assert.equal(item.evidence.edited, false);
      assert.equal(item.evidence.observationCount, 0);
      // Storage mechanics the screen has no decision to make about stay out.
      for (const withheld of ['scopeId', 'exportPolicy', 'status', 'supersedesId', 'supersededById', 'evidenceIds']) {
        assert.equal(withheld in item, false, `${withheld} leaked into the phone’s view of a memory`);
      }
    }
  } finally {
    end();
  }
});

test('a fact the user typed is never presented as something we noticed', async () => {
  begin();
  try {
    const created = await json(await memoryPost(request(OWNER, '/api/mobile/memory', {
      body: { kind: 'fact', content: 'I cook on Fridays', language: 'en' },
    })));
    assert.equal(created.memory.sourceLabel, 'you_told_us');
    assert.equal(created.memory.evidence.origin, 'manual');
    assert.equal(created.memory.evidence.confirmedAt, null);
  } finally {
    end();
  }
});

test('an edit supersedes rather than rewrites, and the replacement is the user speaking', async () => {
  begin();
  try {
    const created = await json(await memoryPost(request(OWNER, '/api/mobile/memory', {
      body: { kind: 'fact', content: 'I cook on Fridays', language: 'en' },
    })));
    const originalId = created.memory.id as string;

    const patched = await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${originalId}`, { body: { content: 'I cook on Saturdays' }, method: 'PATCH' }),
      params(originalId),
    ));

    assert.notEqual(patched.memory.id, originalId, 'the edit rewrote the record in place');
    assert.equal(patched.memory.source, 'user_stated');
    assert.equal(patched.memory.sourceLabel, 'you_told_us');
    assert.equal(patched.memory.evidence.edited, true, 'the replacement does not admit it replaced something');
    assert.ok(patched.memory.evidence.confirmedAt, 'the replacement does not record when the user said it');

    // The prior record is kept in the store and hidden from the list, which is
    // what "history stays inspectable" and "the screen shows what the product
    // can see" mean together.
    const listed = (await json(await memoryGet(request(OWNER, '/api/mobile/memory')))).items as any[];
    assert.deepEqual(listed.map((item) => item.id), [patched.memory.id]);

    const store = createStorageRuntimeMemoryStore();
    const prior = await store.get(originalId);
    assert.equal(prior?.status, 'superseded');
    assert.equal(prior?.supersededById, patched.memory.id);
  } finally {
    end();
  }
});


test('a model’s build and prompt revision never reach the phone', async () => {
  begin();
  try {
    // Written straight to the store: nothing produces a model-inferred record
    // yet, and the wire is narrowed before one exists rather than after.
    const store = createStorageRuntimeMemoryStore();
    await store.put({
      scopeId: OWNER,
      kind: 'hypothesis',
      content: 'You prefer short steps',
      language: 'en',
      source: 'model_inferred',
      confidence: 0.6,
      observedAt: NOW,
      provenance: {
        origin: 'self_description',
        originRef: 'prop-7',
        model: 'gemini-2.5-flash',
        promptVersion: 'describe-v3',
        confirmedByUserAt: NOW,
      },
    }, NOW);

    const items = (await json(await memoryGet(request(OWNER, '/api/mobile/memory')))).items as any[];
    const guess = items.find((item) => item.source === 'model_inferred');
    assert.ok(guess, 'the fixture did not reach the list');
    assert.equal(guess.sourceLabel, 'model_suggested_you_confirmed');
    // What the user is owed is that a model proposed it and that they agreed,
    // which the label and the evidence already say in words.
    assert.equal('model' in guess.provenance, false, 'the model build leaked to the phone');
    assert.equal('promptVersion' in guess.provenance, false, 'the prompt revision leaked to the phone');
    assert.equal(guess.provenance.origin, 'self_description');
  } finally {
    end();
  }
});

test('editing a model’s sentence leaves none of the model’s identifiers on the record', async () => {
  begin();
  try {
    const store = createStorageRuntimeMemoryStore();
    const guess = await store.put({
      scopeId: OWNER,
      kind: 'hypothesis',
      content: 'You prefer short steps',
      language: 'en',
      source: 'model_inferred',
      confidence: 0.6,
      observedAt: NOW,
      provenance: {
        origin: 'self_description',
        model: 'gemini-2.5-flash',
        promptVersion: 'describe-v3',
        confirmedByUserAt: NOW,
      },
    }, NOW);

    const patched = await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${guess.id}`, { body: { content: 'I prefer one step at a time' }, method: 'PATCH' }),
      params(guess.id),
    ));

    // Read from the store, not the wire: the wire hides both fields anyway, so
    // asserting there would pass whether or not they were stored.
    const stored = await createStorageRuntimeMemoryStore().get(patched.memory.id as string);
    assert.equal(stored?.source, 'user_stated');
    assert.equal(stored?.provenance?.model, undefined, 'the user’s own words kept the model that wrote the old ones');
    assert.equal(stored?.provenance?.promptVersion, undefined, 'the user’s own words kept the prompt revision');
    assert.equal(stored?.provenance?.origin, 'self_description', 'the path it arrived by should survive an edit');
  } finally {
    end();
  }
});

test('the client’s "kept until you change it" threshold still separates the two server TTLs', () => {
  // The phone decides "until you change it" versus a real expiry from how long
  // the record is kept, using a constant of its own. Nothing coupled the two
  // until this: raising `DEFAULT_MEMORY_TTL_MS` above the client's threshold
  // would silently word every inference as kept forever, and no test would
  // fail. This one does.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'mobile/src/features/memory/memoryProvenance.ts'),
    'utf8',
  );
  const match = /const KEPT_INDEFINITELY_MS = (\d+) \* 365 \* 24 \* 60 \* 60 \* 1_000;/.exec(source);
  assert.ok(match, 'could not read the client threshold; this check would be vacuous');
  const thresholdMs = Number(match[1]) * 365 * 24 * 60 * 60 * 1_000;

  assert.ok(
    DEFAULT_MEMORY_TTL_MS < thresholdMs,
    'an inference is now kept longer than the client’s threshold, so the screen would call every guess permanent',
  );
  assert.ok(
    USER_STATED_MEMORY_TTL_MS >= thresholdMs,
    'a fact the user stated is now kept for less than the client’s threshold, so the screen would print it an expiry date',
  );
});

// ── Consent ──────────────────────────────────────────────────────

test('memory is listed, added, edited and deleted with recommendation consent off', async () => {
  begin();
  try {
    const consent = createStoragePersonalizationConsentStore();
    await consent.write(OWNER, 'disabled', NOW);
    // The default is also "off"; both are exercised, because a route that read
    // the record would behave differently from one that read nothing.
    assert.equal((await consent.read(OWNER)).state, 'disabled');

    const created = await json(await memoryPost(request(OWNER, '/api/mobile/memory', {
      body: { kind: 'preference', content: 'I answer messages in the evening', language: 'en' },
    })));
    assert.equal(created.success, true);

    const patched = await json(await memoryPatch(
      request(OWNER, `/api/mobile/memory/${created.memory.id}`, { body: { content: 'I answer messages at night' }, method: 'PATCH' }),
      params(created.memory.id),
    ));
    assert.equal(patched.success, true);

    const listed = await json(await memoryGet(request(OWNER, '/api/mobile/memory')));
    assert.equal(listed.items.length, 1);

    const deleted = await json(await memoryDeleteAll(request(OWNER, '/api/mobile/memory', { method: 'DELETE' })));
    assert.equal(deleted.success, true);
  } finally {
    end();
  }
});

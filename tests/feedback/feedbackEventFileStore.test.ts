/**
 * The feedback event log on durable storage — the durability half (UC-1.0c, #142).
 *
 * This was the file-backed store's test and covered what only the on-disk
 * backend could prove. With the backend gone the cases split, and which way
 * each went is stated here rather than left to a diff:
 *
 *  - **Kept, and now stronger.** A restart (a second store over the same
 *    backend — what a second Cloud Run instance is), idempotency surviving
 *    that restart, and Arabic/Hebrew ids stored byte for byte.
 *  - **Kept, in the form that still exists.** A damaged record is skipped
 *    rather than fatal; a record from another schema version is skipped; a
 *    record whose id contradicts its location is not served; a damaged or
 *    misattributed baseline reads as absent. Each plants the malformed record
 *    directly in storage at the path the store would read, which is the
 *    equivalent of a half-applied write or a hand edit.
 *  - **Removed, because the mechanism is gone.** "one file per event at 0600"
 *    and "a completed write leaves no temp file" were about the filesystem.
 *    The adapter writes a document atomically; there is no mode bit and no
 *    temp-then-rename window to leave residue in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_EVENT_SCHEMA_VERSION,
  type AppendFeedbackEventInput,
  type FeedbackBaseline,
} from '../../src/contracts/v1/feedbackContracts.ts';
import { StorageFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import {
  FEEDBACK_BASELINES,
  FEEDBACK_EVENTS,
  docIdForKey,
  userCol,
  userIdForKey,
} from '../../lib/storage/paths.ts';

const OCCURRED = '2026-08-18T09:00:00.000Z';
const RECORDED = '2026-08-18T09:00:03.000Z';

const ARABIC = 'التزام: الاتصال بالطبيب قبل الساعة ٩ — لا تؤجل';
const HEBREW = 'התחייבות: להתקשר לרופא לפני 9 — לא לדחות';
/** Bidi controls and presentation forms a re-encoding pass would introduce. */
const BIDI_MARKS = /[‎‏‪-‮⁦-⁩ﭐ-﷿ﹰ-﻿]/;

function input(overrides: Partial<AppendFeedbackEventInput> = {}): AppendFeedbackEventInput {
  return {
    scopeId: 'scope-a',
    outcome: 'complete',
    subjectId: 'commitment-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt: OCCURRED,
    ...overrides,
  };
}

function baseline(scopeId: string, completedActions = 1): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    counters: {
      ignoredSuggestions: 4, completedActions, delayedActions: 0,
      clarificationSuccesses: 0, clarificationFailures: 2,
    },
    lastUpdatedAt: '2026-08-10T20:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: RECORDED,
  };
}

function eventPath(scopeId: string, id: string): string {
  return `${userCol(userIdForKey(scopeId), FEEDBACK_EVENTS)}/${id}`;
}

function baselinePath(scopeId: string): string {
  return `${userCol(userIdForKey(scopeId), FEEDBACK_BASELINES)}/${docIdForKey(scopeId)}`;
}

function setup(): { storage: MemoryStorageAdapter; store: StorageFeedbackEventStore } {
  const storage = createMemoryStorage();
  return { storage, store: new StorageFeedbackEventStore(storage) };
}

test('events survive a restart of the store over the same backend', async () => {
  const shared = createMemoryStorage();
  const written = await new StorageFeedbackEventStore(shared).append(input(), RECORDED);
  const reopened = new StorageFeedbackEventStore(shared);
  assert.deepEqual(await reopened.get(written.id), written);
  // The key is derived, not remembered, so idempotency outlives the process.
  assert.deepEqual(await reopened.append(input(), '2026-08-19T09:00:00.000Z'), written);
  assert.equal((await reopened.list({ scopeId: 'scope-a' })).length, 1);
});

test('Arabic and Hebrew ids are stored as the user wrote them', async () => {
  const { storage, store } = setup();
  const event = await store.append(input({ scopeId: ARABIC, subjectId: HEBREW }), RECORDED);

  const stored = await storage.get<{ scopeId: string; subjectId: string }>(eventPath(ARABIC, event.id));
  assert.ok(stored, 'the event was not stored under its scope');
  assert.equal(stored.scopeId, ARABIC);
  assert.equal(stored.subjectId, HEBREW);
  assert.equal(BIDI_MARKS.test(JSON.stringify(stored)), false, 'no bidi control or presentation form may be introduced');
  assert.equal(
    Buffer.from(stored.subjectId, 'utf8').equals(Buffer.from(HEBREW, 'utf8')),
    true,
    'the stored bytes must be the ones the user supplied',
  );
  assert.equal((await store.get(event.id))?.scopeId, ARABIC);
});

test('a damaged event record is skipped rather than fatal', async () => {
  const { storage, store } = setup();
  const healthy = await store.append(input(), RECORDED);
  const damaged = await store.append(input({ subjectId: 'commitment-2' }), RECORDED);
  await storage.set(eventPath('scope-a', damaged.id), { scopeId: 'scope-a', outcome: 'comp' });

  assert.deepEqual((await store.list({ scopeId: 'scope-a' })).map((event) => event.id), [healthy.id]);
  assert.equal(await store.get(damaged.id), null, 'a partial record must never surface as an event');
  assert.equal(await store.revoke(damaged.id, RECORDED), false);
});

test('an event record written by another schema version is skipped', async () => {
  const { storage, store } = setup();
  const event = await store.append(input(), RECORDED);
  await storage.set(eventPath('scope-a', event.id), { ...event, version: 'feedback-event-v0' });

  assert.equal(await store.get(event.id), null);
  assert.equal((await store.list({ scopeId: 'scope-a' })).length, 0);
});

test('a record whose id contradicts its location is not served', async () => {
  const { storage, store } = setup();
  const mine = await store.append(input(), RECORDED);
  const other = await store.append(input({ scopeId: 'scope-b' }), RECORDED);
  // A hand-placed record claiming to be one it is not: the id is what a revoke
  // endpoint addresses, so serving it at the wrong location would let one
  // lookup return another event entirely.
  await storage.set(eventPath('scope-a', mine.id), { ...other, id: other.id });

  assert.equal(await store.get(mine.id), null);
});

test('a damaged or misattributed baseline reads as absent rather than throwing', async () => {
  const { storage, store } = setup();
  await store.writeBaseline(baseline('scope-a'));
  assert.ok(await storage.get(baselinePath('scope-a')), 'the baseline is stored as its own document');

  // Re-point the record at another scope: the id is a digest of the scopeId,
  // but the id is never trusted over the record itself.
  await storage.set(baselinePath('scope-a'), baseline('scope-b', 9));
  assert.equal(await store.readBaseline('scope-a'), null, "another scope's counters must not be served here");

  await storage.set(baselinePath('scope-a'), { scopeId: 'scope-a', counters: {} });
  assert.equal(await store.readBaseline('scope-a'), null);
});

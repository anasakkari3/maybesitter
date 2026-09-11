/**
 * Deletion completeness for the feedback event log (Sprint 03, issue #13).
 *
 * A scope deletion must leave nothing holding that user's behaviour, including
 * a record too damaged to read, and must reach the migration baseline as well
 * — those counters are the user's history too.
 *
 * ── What survived the storage move (UC-1.0c, #142) ───────────────
 *
 * These asserted on the filesystem, because the failure mode was a *file* the
 * store could no longer see. Two such files no longer exist: the temp file a
 * crash left between write and rename, for an event and for a baseline. The
 * adapter writes one document atomically, so there is no rename window to
 * orphan anything in, and those two cases are removed rather than ported — the
 * mechanism they guarded is gone. Every other property is kept, and checked
 * against storage directly: `pathsForTests()` is the equivalent of the old
 * directory listing, and it is what catches a document the store's own API
 * can no longer see.
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
import { FEEDBACK_EVENTS, USERS, userCol, userIdForKey } from '../../lib/storage/paths.ts';

const OCCURRED = '2026-08-18T09:00:00.000Z';
const RECORDED = '2026-08-18T09:00:03.000Z';

function input(overrides: Partial<AppendFeedbackEventInput> = {}): AppendFeedbackEventInput {
  return {
    scopeId: 'alice',
    outcome: 'complete',
    subjectId: 'commitment-1',
    actor: 'user',
    source: 'mobile_action',
    occurredAt: OCCURRED,
    ...overrides,
  };
}

function baseline(scopeId: string): FeedbackBaseline {
  return {
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    scopeId,
    counters: {
      ignoredSuggestions: 3, completedActions: 7, delayedActions: 2,
      clarificationSuccesses: 5, clarificationFailures: 1,
    },
    lastUpdatedAt: '2026-08-10T20:00:00.000Z',
    timestampsUnavailable: true,
    migratedAt: RECORDED,
  };
}

function setup(): { storage: MemoryStorageAdapter; store: StorageFeedbackEventStore } {
  const storage = createMemoryStorage();
  return { storage, store: new StorageFeedbackEventStore(storage) };
}

/** Every document held anywhere in one scope's user tree, however damaged. */
function heldFor(storage: MemoryStorageAdapter, scopeId: string): string[] {
  const prefix = `${USERS}/${userIdForKey(scopeId)}/`;
  return storage.pathsForTests().filter((path) => path.startsWith(prefix));
}

test('SECURITY: a traversing or malformed id cannot read, revoke or delete anything', async () => {
  const { storage, store } = setup();
  await store.append(input(), RECORDED);

  for (const evil of ['../victim', '../../etc/passwd', 'fbk_../../victim', '/etc/passwd', 'fbk_a/../../victim']) {
    assert.equal(await store.get(evil), null, `get(${evil}) must not resolve`);
    assert.equal(await store.revoke(evil, RECORDED), false, `revoke(${evil}) must not resolve`);
  }
  // A scopeId is caller text too, and it names the baseline document. It is
  // hashed into a legal path, so it can only ever reach its own tree.
  await store.writeBaseline(baseline('../../victim'));
  assert.equal(await store.deleteScope('../../victim'), 0);

  assert.equal(heldFor(storage, 'alice').length, 1, "alice's event must survive untouched");
});

test('SECURITY: deleteScope removes a record even when it cannot be parsed', async () => {
  const { storage, store } = setup();
  const event = await store.append(input(), RECORDED);
  // Corrupt it in place, as a half-applied write would. The store's own reads
  // now skip it, which is exactly why deletion must not depend on them.
  await storage.set(`${userCol(userIdForKey('alice'), FEEDBACK_EVENTS)}/${event.id}`, {
    scopeId: 'alice',
    subjectId: 'SECRET',
  });

  await store.deleteScope('alice');
  assert.deepEqual(heldFor(storage, 'alice'), [], 'no record holding alice content may survive deleteScope');
});

test('SECURITY: deleteScope removes the migration baseline, not only the events', async () => {
  const { storage, store } = setup();
  await store.append(input({ scopeId: 'dana' }), RECORDED);
  await store.writeBaseline(baseline('dana'));

  assert.equal(await store.deleteScope('dana'), 1, 'the count reports events, and the baseline is not an event');
  assert.equal(await store.readBaseline('dana'), null);
  assert.deepEqual(heldFor(storage, 'dana'), [], "the pre-event-log counters are the user's data too");
});

test('SECURITY: a record belonging to a different scope is never deleted', async () => {
  const { storage, store } = setup();
  await store.append(input({ scopeId: 'carol' }), RECORDED);
  await store.writeBaseline(baseline('carol'));

  assert.equal(await store.deleteScope('erin'), 0, "deleting erin must not touch carol's data");
  assert.equal(heldFor(storage, 'carol').length, 2, "carol's event and baseline must survive");
  assert.ok(await store.readBaseline('carol'), "carol's baseline must survive another user's deletion");
});

test('SECURITY: a sibling scope keeps its events when a neighbour is deleted', async () => {
  const { store } = setup();
  await store.append(input({ scopeId: 'alice' }), RECORDED);
  await store.append(input({ scopeId: 'alice', subjectId: 'commitment-2' }), RECORDED);
  const kept = await store.append(input({ scopeId: 'bob' }), RECORDED);
  await store.writeBaseline(baseline('bob'));

  assert.equal(await store.deleteScope('alice'), 2);
  assert.deepEqual((await store.list({ scopeId: 'bob' })).map((event) => event.id), [kept.id]);
  assert.deepEqual(await store.readBaseline('bob'), baseline('bob'));
});

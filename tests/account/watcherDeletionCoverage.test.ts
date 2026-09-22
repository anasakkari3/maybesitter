/**
 * Deleting an account stops it being watched (#527).
 *
 * #527's acceptance criteria include "account deletion clears history/config",
 * and the watchers are the part of this product that keeps acting on somebody
 * after they have stopped using it. A monitor that survives a deletion does
 * not merely leave a row in a table: the sweep is a collection-group read over
 * every account at once, so a surviving watcher document is re-observed every
 * minute, for a person who asked to be gone.
 *
 * Two existing files already hold the *registry* to account: `tests/storage/
 * deletionCoverage.test.ts` checks `USER_SCOPED_COLLECTIONS` against the code,
 * and `tests/account/accountDeletion.test.ts` seeds one synthetic document in
 * each listed collection and deletes it. Both are static in the way that
 * matters here — they seed `{ uid, collection }` at a path they construct
 * themselves, so they would keep passing if the watcher store wrote somewhere
 * else, if the engine's firing artifacts landed outside the tree, or if
 * `deleteAccount` stopped reaching the tree at all.
 *
 * So this file uses nothing synthetic. The watcher is created through
 * `WatcherStore`, the history, proposal and notification rows are produced by
 * making the engine actually fire, the account goes through the real
 * `deleteAccount`, and the closing assertion is the behavioural one: a sweep
 * run afterwards sees nothing of that account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import {
  USER_SCOPED_COLLECTIONS,
  WATCHERS,
  WATCHER_EVENTS,
  WATCHER_NOTIFICATIONS,
  WATCHER_PROPOSALS,
  userDoc,
} from '../../lib/storage/paths.ts';
import { deleteAccount, type DeletionAuthAdmin } from '../../lib/account/accountDeletion.ts';
import { resetDeletionHooksForTests } from '../../lib/account/deletionHooks.ts';
import { createWatcherStore } from '../../lib/watchers/watcherStore.ts';
import { runWatcherSweep } from '../../lib/watchers/watcherEngine.ts';
import { createWatcherSignalRegistry, type WatcherSignalObserver } from '../../lib/watchers/signals.ts';
import { WATCHER_SIGNAL_SCHEMA_VERSION } from '../../src/contracts/v1/watcherContracts.ts';
import type { NewWatcherInput } from '../../lib/watchers/watcherStore.ts';

const PEPPER = 'test-pepper-not-the-real-one';
const TARGET = 'user_watched_and_deleted';
const SIBLING = 'user_still_watching';
const T0 = new Date('2026-09-20T09:00:00.000Z');
const T1 = new Date('2026-09-20T09:01:00.000Z');
const T2 = new Date('2026-09-20T09:02:00.000Z');

/** Every collection a watcher can leave something in. */
const WATCHER_COLLECTIONS = [WATCHERS, WATCHER_EVENTS, WATCHER_PROPOSALS, WATCHER_NOTIFICATIONS] as const;

let storage: MemoryStorageAdapter;
/** Flipped between sweeps so the second observation is a change and fires. */
let digest = 'digest-one';

const observer: WatcherSignalObserver = {
  supports: (source) => source.signalKind === 'flight',
  async observe(source, context) {
    return {
      schemaVersion: WATCHER_SIGNAL_SCHEMA_VERSION,
      signalId: `flight:${source.subjectRef}:${digest}`,
      provider: source.provider,
      signalKind: 'flight',
      subjectRef: source.subjectRef,
      observedAt: context.now,
      stateDigest: digest,
      provenanceRef: `flights/${source.subjectRef}`,
      measures: [],
    };
  },
};

function fakeAuth(): DeletionAuthAdmin {
  return { async revokeRefreshTokens() {}, async deleteUser() {} };
}

function watcherInput(effect: NewWatcherInput['effect']): NewWatcherInput {
  return {
    enabled: true,
    // No connection: the watcher must be able to reach `active` and fire
    // without a provider record, so that what this file proves is deletion
    // and not connection plumbing.
    source: { provider: 'aviation', connectionId: null, signalKind: 'flight', subjectRef: 'flt_ly315' },
    condition: { kind: 'digest_changed' },
    effect,
    createdBy: 'user',
  };
}

async function sweep(now: Date): Promise<void> {
  await runWatcherSweep({ storage, now, registry: createWatcherSignalRegistry([observer]) });
}

/** Everything under `users/{uid}/` in any watcher collection. */
async function watcherRowsFor(uid: string): Promise<string[]> {
  const prefix = `${userDoc(uid)}/`;
  const rows: string[] = [];
  for (const collection of WATCHER_COLLECTIONS) {
    rows.push(...(await storage.listGroup(collection))
      .filter((row) => row.path.startsWith(prefix))
      .map((row) => row.path));
  }
  return rows.sort();
}

/**
 * An account with watchers that have actually run: three effects, so the
 * firing writes a proposal and a notification as well as a history row.
 */
async function seedWatchedAccount(uid: string): Promise<void> {
  const store = createWatcherStore(uid, storage);
  await store.create(watcherInput('notify'), T0.toISOString());
  await store.create(watcherInput('propose_commitment'), T0.toISOString());
  await store.create(watcherInput('update_context'), T0.toISOString());
}

function begin(): void {
  process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER = PEPPER;
  resetDeletionHooksForTests();
  storage = createMemoryStorage();
  digest = 'digest-one';
}

function end(): void {
  resetDeletionHooksForTests();
  delete process.env.MAYBESITTER_DELETION_RECEIPT_PEPPER;
}

test('a deleted account keeps no watcher configuration and no watcher history', async () => {
  begin();
  try {
    await storage.set(userDoc(TARGET), { uid: TARGET });
    await storage.set(userDoc(SIBLING), { uid: SIBLING });
    await seedWatchedAccount(TARGET);
    await seedWatchedAccount(SIBLING);

    // Prime, then change, so the second sweep fires and leaves real history.
    await sweep(T0);
    digest = 'digest-two';
    await sweep(T1);

    // The seed is real, and it reached every collection a watcher writes. A
    // deletion test whose fixture never landed proves nothing, and this is the
    // half that the synthetic seeds elsewhere cannot state: these paths were
    // chosen by the store and the engine, not by this file.
    const before = await watcherRowsFor(TARGET);
    for (const collection of WATCHER_COLLECTIONS) {
      assert.ok(
        before.some((path) => path.includes(`/${collection}/`)),
        `nothing was written to ${collection}, so its deletion is not being tested`,
      );
    }

    await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });

    assert.deepEqual(
      await watcherRowsFor(TARGET),
      [],
      'the deleted account is still being watched, and its firing history survived',
    );
    assert.equal(await storage.get(userDoc(TARGET)), null);

    // The control. A deletion that emptied the database would satisfy every
    // assertion above.
    const sibling = await watcherRowsFor(SIBLING);
    for (const collection of WATCHER_COLLECTIONS) {
      assert.ok(
        sibling.some((path) => path.includes(`/${collection}/`)),
        `deleting one account removed another account's ${collection}`,
      );
    }
  } finally {
    end();
  }
});

test('the sweep no longer sees a deleted account, so nothing of theirs can fire again', async () => {
  begin();
  try {
    await storage.set(userDoc(TARGET), { uid: TARGET });
    await storage.set(userDoc(SIBLING), { uid: SIBLING });
    await seedWatchedAccount(TARGET);
    await seedWatchedAccount(SIBLING);
    await sweep(T0);

    // Six watchers across two accounts, all primed and all live. This is the
    // number the sweep must stop counting half of.
    const primed = await runWatcherSweep({ storage, now: T0, registry: createWatcherSignalRegistry([observer]) });
    assert.equal(primed.scanned, 6, 'the fixture is not what this test thinks it is');

    await deleteAccount(TARGET, { initiatedBy: 'user', storage, auth: fakeAuth() });

    // The behavioural claim, and the reason this file exists rather than a
    // path assertion alone: the sweep reads `watchers` as a collection group,
    // across every account at once. A document that survived a deletion is not
    // a stale row in a table — it is re-observed every minute, for somebody who
    // asked to be gone.
    digest = 'digest-two';
    const after = await runWatcherSweep({ storage, now: T2, registry: createWatcherSignalRegistry([observer]) });
    assert.equal(after.scanned, 3, 'the sweep is still visiting a deleted account\'s watchers');
    assert.deepEqual(after.failures, []);

    // And nothing it did was about the deleted account: the firing it recorded
    // belongs to the neighbour, who is still a user.
    const events = await storage.listGroup(WATCHER_EVENTS);
    assert.ok(events.length > 0, 'the surviving account stopped firing, so this proves nothing about scope');
    assert.deepEqual(
      events.filter((row) => row.path.startsWith(`${userDoc(TARGET)}/`)).map((row) => row.path),
      [],
      'a sweep after the deletion wrote new history for the deleted account',
    );
  } finally {
    end();
  }
});

test('every watcher collection is one the deletion tests are held to', () => {
  // The registry direction, and worth being precise about what it does and
  // does not buy. `deleteTree` is structural in both adapters — a prefix sweep
  // in memory, `recursiveDelete` in Firestore — so it is `USER_SCOPED_COLLECTIONS`
  // that follows the data rather than the data that follows the list. What the
  // list governs is the *checking*: `tests/storage/deletionCoverage.test.ts`
  // and `tests/account/accountDeletion.test.ts` seed and assert exactly the
  // collections it names, so a watcher collection missing from it is a
  // collection those two files stop looking at. This says out loud that all
  // four are on it.
  for (const collection of WATCHER_COLLECTIONS) {
    assert.ok(
      (USER_SCOPED_COLLECTIONS as readonly string[]).includes(collection),
      `${collection} is not in USER_SCOPED_COLLECTIONS, so account deletion does not cover it`,
    );
  }
});

/**
 * Every write a request makes lands in the caller's own tree (UC-1.4, #148).
 *
 * The invariant: no user-owned content may be stored under another user's path
 * or at a process-global one. Before UC-1.0e (#144) the mobile routes shared a
 * single in-process command service, so "whose data is this" was answered by
 * whichever request ran last. Now the uid comes from a verified token and every
 * path is built from it — and this file is what keeps that true.
 *
 * It does not read the source looking for path builders. It drives the real
 * route handlers as two different users through a storage adapter that records
 * every write, and then judges the paths those writes actually used. A new
 * feature that stores something outside the caller's tree fails here without
 * anyone having to remember to add it to a list.
 *
 * ── The allowlist is deliberate, not discovered ──────────────────
 *
 * Two top-level collections are legitimate, and both are named below with the
 * reason they are not user-owned. Anything else appearing at the top level is a
 * finding: either it holds user content and belongs in the tree, or it is
 * operational and needs the same argument written down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { CAPTURE_PROPOSALS, COMMITMENTS, EVENTS, INCIDENTS, USERS } from '../../lib/storage/paths.ts';
import type {
  ListOptions,
  StorageAdapter,
  StorageTransaction,
  StoredDoc,
} from '../../lib/storage/storageAdapter.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { POST as capturePost } from '../../src/app/api/mobile/capture/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as todayGet } from '../../src/app/api/mobile/commitments/today/route.ts';
import { PATCH as commitmentPatch } from '../../src/app/api/mobile/commitments/[id]/route.ts';
import { POST as actionPost } from '../../src/app/api/mobile/commitments/[id]/actions/route.ts';
import { POST as trustPost } from '../../src/app/api/mobile/pilot/trust/route.ts';
import { POST as analyticsPost } from '../../src/app/api/mobile/analytics/route.ts';

/**
 * Top-level collections that are not user-owned.
 *
 * - `incidents` is the operator-only trust incident log. It is written by
 *   operators about the service, is readable by no client (firestore.rules),
 *   and carries no user content.
 * - `jobs` is the scheduler's queue (lib/scheduler/storageSchedulerStore). It is
 *   operational state for the whole service, not one person's data, which is
 *   why `USER_SCOPED_COLLECTIONS` deliberately excludes it.
 *
 * A collection added here needs the same kind of sentence, and account deletion
 * (#149) has to be able to explain why it does not need to touch it.
 */
const NON_USER_TOP_LEVEL = new Set([INCIDENTS, 'jobs']);

const baseUrl = 'http://localhost:3000';

/** A storage adapter that remembers which paths were written through it. */
class RecordingStorage implements StorageAdapter {
  readonly written: string[] = [];
  constructor(private readonly inner: StorageAdapter) {}

  private record(path: string): void {
    this.written.push(path);
  }

  get<T>(path: string): Promise<T | null> {
    return this.inner.get<T>(path);
  }
  list<T>(collectionPath: string, o?: ListOptions): Promise<StoredDoc<T>[]> {
    return this.inner.list<T>(collectionPath, o);
  }
  listGroup<T>(collectionId: string, o?: ListOptions): Promise<Array<StoredDoc<T> & { path: string }>> {
    return this.inner.listGroup<T>(collectionId, o);
  }
  async set<T>(path: string, value: T): Promise<void> {
    this.record(path);
    return this.inner.set<T>(path, value);
  }
  async delete(path: string): Promise<void> {
    this.record(path);
    return this.inner.delete(path);
  }
  async deleteTree(path: string): Promise<number> {
    this.record(path);
    return this.inner.deleteTree(path);
  }
  runTransaction<R>(fn: (tx: StorageTransaction) => Promise<R>): Promise<R> {
    return this.inner.runTransaction((tx) => fn(this.wrap(tx)));
  }

  /** The same recording, for writes queued inside a transaction. */
  private wrap(tx: StorageTransaction): StorageTransaction {
    const record = (path: string) => this.record(path);
    return {
      get: (path) => tx.get(path),
      list: (path, o) => tx.list(path, o),
      listGroup: (id, o) => tx.listGroup(id, o),
      set: (path, value) => { record(path); tx.set(path, value); },
      merge: (path, value) => { record(path); tx.merge(path, value); },
      create: (path, value) => { record(path); tx.create(path, value); },
      delete: (path) => { record(path); tx.delete(path); },
    } as StorageTransaction;
  }
}

/** Which user a path belongs to, or null when it is not in a user tree. */
function ownerOf(path: string): string | null {
  const segments = path.split('/');
  return segments[0] === USERS && segments.length >= 2 ? segments[1]! : null;
}

function request(uid: string, path: string, body?: unknown, method?: string): Request {
  const headers = new Headers({ authorization: `Bearer ${tokenFor(uid)}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return new Request(`${baseUrl}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

/**
 * A realistic session: capture, confirm, read, edit, act, consent, analytics.
 * Between them these touch commitments, reminders, events, the user document,
 * capture proposals, trust and analytics events.
 */
async function drive(uid: string): Promise<void> {
  const proposal = await (await capturePost(
    request(uid, '/api/mobile/capture', { text: 'Call the clinic tomorrow at 9', timezone: 'UTC' }),
  )).json() as { proposalId?: string; items?: Array<{ itemId: string }> };

  if (proposal.proposalId && proposal.items?.length) {
    const confirmed = await (await confirmPost(
      request(uid, '/api/mobile/capture/confirm', {
        proposalId: proposal.proposalId,
        itemIds: [proposal.items[0]!.itemId],
      }),
    )).json() as { persisted?: Array<{ commitmentId: string }> };

    const commitmentId = confirmed.persisted?.[0]?.commitmentId;
    if (commitmentId) {
      await commitmentPatch(
        request(uid, `/api/mobile/commitments/${commitmentId}`, { title: 'Call the clinic' }, 'PATCH'),
        params(commitmentId),
      );
      await actionPost(
        request(uid, `/api/mobile/commitments/${commitmentId}/actions`, { action: 'complete' }),
        params(commitmentId),
      );
    }
  }

  await todayGet(request(uid, '/api/mobile/commitments/today'));
  await trustPost(request(uid, '/api/mobile/pilot/trust', { action: 'grant_recommendation_consent' }));
  await analyticsPost(request(uid, '/api/mobile/analytics', {
    events: [{ name: 'app_opened', occurredAt: new Date().toISOString() }],
  }));
}

let auth: FakeAuthControls | null = null;

test('every write a request makes lands in that caller\'s own tree', async () => {
  const A = uidFor('PathInvariantA');
  const B = uidFor('PathInvariantB');
  auth = installFakeAuth();
  const recording = new RecordingStorage(createMemoryStorage());
  setStorageForTests(recording as unknown as StorageAdapter);
  try {
    for (const uid of [A, B]) {
      const before = recording.written.length;
      await drive(uid);
      const paths = recording.written.slice(before);
      assert.ok(paths.length > 0, `driving ${uid} wrote nothing, so this test would prove nothing`);

      // The session has to have touched real ground, or the judgement below is
      // about an empty set. These are the collections a capture-to-completion
      // round trip must write.
      for (const collection of [COMMITMENTS, EVENTS, CAPTURE_PROPOSALS]) {
        assert.ok(
          paths.some((path) => path.startsWith(`${USERS}/${uid}/${collection}/`)),
          `driving ${uid} never wrote ${collection}; the session is not exercising what it claims`,
        );
      }
      assert.ok(paths.includes(`${USERS}/${uid}`), 'the user document was never written');

      for (const path of paths) {
        const owner = ownerOf(path);
        if (owner === null) {
          const top = path.split('/')[0]!;
          assert.ok(
            NON_USER_TOP_LEVEL.has(top),
            `${path} is written outside every user tree, and "${top}" is not a documented non-user collection`,
          );
          continue;
        }
        assert.equal(owner, uid, `${path} was written while acting as ${uid}`);
      }
    }
  } finally {
    resetStorageForTests();
    auth?.restore();
    auth = null;
  }
});

test('one user\'s session never writes into another user\'s tree', async () => {
  // The assertion above is per-request. This one is the whole point stated
  // directly: A's traffic must be invisible in B's tree, whatever order the
  // requests ran in.
  const A = uidFor('CrossTreeA');
  const B = uidFor('CrossTreeB');
  auth = installFakeAuth();
  const recording = new RecordingStorage(createMemoryStorage());
  setStorageForTests(recording as unknown as StorageAdapter);
  try {
    await drive(A);
    const afterA = recording.written.length;
    await drive(B);

    const aPaths = recording.written.slice(0, afterA);
    const bPaths = recording.written.slice(afterA);
    assert.equal(aPaths.filter((path) => ownerOf(path) === B).length, 0, 'A wrote into B\'s tree');
    assert.equal(bPaths.filter((path) => ownerOf(path) === A).length, 0, 'B wrote into A\'s tree');
    assert.ok(aPaths.some((path) => ownerOf(path) === A), 'A wrote nothing of its own');
    assert.ok(bPaths.some((path) => ownerOf(path) === B), 'B wrote nothing of its own');
  } finally {
    resetStorageForTests();
    auth?.restore();
    auth = null;
  }
});

test('the documented non-user collections are the only ones outside the trees', async () => {
  // Pins the allowlist itself. If a future feature writes `sessions/...` at the
  // top level, the test above fails with the path; this one states what the
  // permitted set is, so the two failures together say what to decide.
  assert.deepEqual(Array.from(NON_USER_TOP_LEVEL).sort(), ['incidents', 'jobs']);
});

/**
 * A watcher's «اقترح التزام» proposal is shown and decided (QA audit de7fcb8,
 * CA6.1, owner decision 2026-11-15).
 *
 * A `propose_commitment` firing writes `watcherProposals/wpr_*` and nothing
 * read it. The two routes under test are what the app reads and answers:
 *
 *   GET  /api/mobile/watchers/proposals        the owner's open proposals
 *   POST /api/mobile/watchers/proposals/{id}   { decision: 'accept', title } | { decision: 'dismiss' }
 *
 * and they hold:
 *   - only the owner sees or decides a proposal (another account gets 404);
 *   - accept makes one confirmed commitment through the deterministic
 *     CreateDraft + ConfirmCommitment commands, in the claim's transaction;
 *   - a proposal is decided once: a second tap, or two at once from two
 *     phones, makes no second commitment and cannot flip the answer;
 *   - nothing is saved without an explicit accept carrying the person's title.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, userCol, userDoc, userSubDoc, WATCHER_PROPOSALS } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { seedLiveAccount } from '../support/liveAccount.ts';
import { GET as listProposals } from '../../src/app/api/mobile/watchers/proposals/route.ts';
import { POST as decideProposal } from '../../src/app/api/mobile/watchers/proposals/[id]/route.ts';
import type { WatcherProposal } from '../../src/contracts/v1/watcherContracts.ts';

const BASE = 'https://api.maybesitter.test';
const ALICE = uidFor('ProposalAlice');
const BOB = uidFor('ProposalBlake');
const PROPOSAL = `wpr_${'a'.repeat(64)}`;
const OTHER = `wpr_${'b'.repeat(64)}`;

let storage: MemoryStorageAdapter;
let auth: FakeAuthControls | null = null;

async function begin(): Promise<void> {
  storage = createMemoryStorage();
  setStorageForTests(storage);
  auth = installFakeAuth();
  await seedLiveAccount(ALICE, storage);
  await seedLiveAccount(BOB, storage);
}

function end(): void {
  auth?.restore();
  auth = null;
  resetStorageForTests();
}

function request(path: string, options: { uid?: string; body?: unknown } = {}): Request {
  const headers = new Headers();
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.uid) headers.set('authorization', `Bearer ${tokenFor(options.uid)}`);
  return new Request(`${BASE}${path}`, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function propose(uid: string, proposalId: string, proposedAt = '2026-11-15T08:00:00.000Z'): Promise<void> {
  const proposal: WatcherProposal = {
    schemaVersion: 'watcher-proposal-v1',
    proposalId,
    watcherId: 'wtc_00000000-0000-4000-8000-000000000001',
    scopeId: uid,
    state: 'proposed',
    signalKind: 'readiness',
    subjectRef: 'self',
    reason: 'digest_changed',
    proposedAt,
    provenanceRef: 'userState/readiness',
  };
  await storage.set(userSubDoc(uid, WATCHER_PROPOSALS, proposalId), proposal);
}

async function decide(uid: string, id: string, body: unknown): Promise<Response> {
  return decideProposal(request(`/api/mobile/watchers/proposals/${id}`, { uid, body }), params(id));
}

async function commitments(uid: string) {
  return (await storage.list<{ id: string; title: string; status: string }>(userCol(uid, COMMITMENTS))).map((row) => row.data);
}

async function stored(uid: string, id: string): Promise<WatcherProposal | null> {
  return storage.get<WatcherProposal>(userSubDoc(uid, WATCHER_PROPOSALS, id));
}

test('the owner lists their open proposals, newest first; nobody else sees them', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL, '2026-11-15T08:00:00.000Z');
    await propose(ALICE, OTHER, '2026-11-15T09:00:00.000Z');
    const response = await listProposals(request('/api/mobile/watchers/proposals', { uid: ALICE }));
    assert.equal(response.status, 200);
    const body = await response.json() as { proposals: Array<{ proposalId: string; signalKind: string; proposedAt: string }> };
    assert.deepEqual(body.proposals.map((row) => row.proposalId), [OTHER, PROPOSAL]);
    assert.equal(body.proposals[0]!.signalKind, 'readiness');

    const bob = await listProposals(request('/api/mobile/watchers/proposals', { uid: BOB }));
    assert.deepEqual((await bob.json() as { proposals: unknown[] }).proposals, []);
    assert.equal((await listProposals(request('/api/mobile/watchers/proposals'))).status, 401);
  } finally {
    end();
  }
});

test('accept makes exactly one confirmed commitment with the person\'s title', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    const response = await decide(ALICE, PROPOSAL, { decision: 'accept', title: 'Take a short walk' });
    assert.equal(response.status, 200);
    const body = await response.json() as { proposal: { state: string; commitmentId: string } };
    assert.equal(body.proposal.state, 'accepted');

    const made = await commitments(ALICE);
    assert.equal(made.length, 1);
    assert.equal(made[0]!.title, 'Take a short walk');
    assert.equal(made[0]!.status, 'active');
    assert.equal(made[0]!.id, body.proposal.commitmentId);
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'accepted');

    const open = await listProposals(request('/api/mobile/watchers/proposals', { uid: ALICE }));
    assert.deepEqual((await open.json() as { proposals: unknown[] }).proposals, [], 'a decided proposal is still offered');
  } finally {
    end();
  }
});

test('a proposal is decided once: a second tap and two phones at once make one commitment', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    const [first, second] = await Promise.all([
      decide(ALICE, PROPOSAL, { decision: 'accept', title: 'Take a short walk' }),
      decide(ALICE, PROPOSAL, { decision: 'accept', title: 'Take a short walk' }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    const again = await decide(ALICE, PROPOSAL, { decision: 'accept', title: 'Take a short walk' });
    assert.equal(again.status, 200);
    assert.equal((await commitments(ALICE)).length, 1, 'one proposal became two commitments');

    // And the answer cannot be flipped afterwards.
    const flip = await decide(ALICE, PROPOSAL, { decision: 'dismiss' });
    assert.equal((await flip.json() as { proposal: { state: string } }).proposal.state, 'accepted');
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'accepted');
    assert.equal((await commitments(ALICE)).length, 1);
  } finally {
    end();
  }
});

test('dismiss saves nothing and cannot be turned into an accept', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    const response = await decide(ALICE, PROPOSAL, { decision: 'dismiss' });
    assert.equal(response.status, 200);
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'dismissed');
    await decide(ALICE, PROPOSAL, { decision: 'accept', title: 'Take a short walk' });
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'dismissed');
    assert.deepEqual(await commitments(ALICE), []);
  } finally {
    end();
  }
});

test('another account cannot read or decide a proposal that is not theirs', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    const response = await decide(BOB, PROPOSAL, { decision: 'accept', title: 'Take a short walk' });
    assert.equal(response.status, 404);
    assert.deepEqual(await commitments(BOB), []);
    assert.deepEqual(await commitments(ALICE), []);
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'proposed');
  } finally {
    end();
  }
});

test('nothing is saved without an explicit accept and a real title', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    for (const body of [
      {},
      { decision: 'accept' },
      { decision: 'accept', title: '  ' },
      { decision: 'accept', title: 'x'.repeat(201) },
      { decision: 'yes', title: 'Take a short walk' },
      { decision: 'accept', title: 'Take a short walk', scopeId: BOB },
    ]) {
      const response = await decide(ALICE, PROPOSAL, body);
      assert.equal(response.status, 400, `accepted ${JSON.stringify(body)}`);
    }
    assert.equal((await decide(ALICE, 'not-a-proposal', { decision: 'dismiss' })).status, 400);
    assert.equal((await decide(ALICE, OTHER, { decision: 'dismiss' })).status, 404);
    assert.deepEqual(await commitments(ALICE), []);
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'proposed');
  } finally {
    end();
  }
});

test('a deleted account cannot accept: no commitment, and the proposal is untouched', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    // Deleted as account deletion leaves it: the trust record says so.
    const user = (await storage.get<{ trust: Record<string, unknown> }>(userDoc(ALICE)))!;
    await storage.set(userDoc(ALICE), { ...user, trust: { ...user.trust, deletedAt: '2026-11-15T07:00:00.000Z' } });
    const response = await decide(ALICE, PROPOSAL, { decision: 'accept', title: 'Take a short walk' });
    assert.notEqual(response.status, 200);
    assert.deepEqual(await commitments(ALICE), []);
    assert.equal((await stored(ALICE, PROPOSAL))!.state, 'proposed');
  } finally {
    end();
  }
});

test('control and direction-override characters never reach the commitment title', async () => {
  await begin();
  try {
    await propose(ALICE, PROPOSAL);
    const response = await decide(ALICE, PROPOSAL, { decision: 'accept', title: '‮klaw\u0007 a ⁦take⁩\u0000' });
    assert.equal(response.status, 200);
    assert.equal((await commitments(ALICE))[0]!.title, 'klaw a take');
    await propose(ALICE, OTHER);
    assert.equal((await decide(ALICE, OTHER, { decision: 'accept', title: '‮\u0007⁦' })).status, 400, 'a title of controls alone was accepted');
  } finally {
    end();
  }
});

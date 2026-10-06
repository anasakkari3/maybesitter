import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryStorage,
  resetStorageForTests,
  setStorageForTests,
  type ListOptions,
  type StorageAdapter,
  type StorageTransaction,
} from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { setCaptureChatDependenciesForTests } from '../../lib/services/captureChat/captureChatService.ts';
import { POST as chatPost } from '../../src/app/api/mobile/capture/chat/route.ts';
import { POST as clarifyPost } from '../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as seedsGet, POST as seedsPost } from '../../src/app/api/mobile/seeds/route.ts';

const BASE = 'http://localhost:3000';
const ZONE = 'Asia/Jerusalem';

type Raw = { status: number; body: Record<string, any> };
type Proposal = {
  proposalId: string;
  revision: number;
  items: Array<{ itemId: string; title: string; clarification?: { questionId: string; options: Array<{ optionId: string }> } | null }>;
  seeds: Array<{ seedItemId: string; summary: string }>;
};
type Chat = { conversationId: string; proposal: Proposal };

/** Runs one deterministic competing operation immediately before the next transaction. */
class InterleavingStorage implements StorageAdapter {
  private beforeNext: (() => Promise<void>) | null = null;

  constructor(private readonly inner: StorageAdapter) {}

  arm(operation: () => Promise<void>): void {
    assert.equal(this.beforeNext, null, 'an interleaving is already armed');
    this.beforeNext = operation;
  }

  get<T>(path: string) { return this.inner.get<T>(path); }
  list<T>(path: string, options?: ListOptions) { return this.inner.list<T>(path, options); }
  listGroup<T>(id: string, options?: ListOptions) { return this.inner.listGroup<T>(id, options); }
  set<T>(path: string, value: T) { return this.inner.set(path, value); }
  delete(path: string) { return this.inner.delete(path); }
  deleteTree(path: string) { return this.inner.deleteTree(path); }

  async runTransaction<R>(fn: (tx: StorageTransaction) => Promise<R>): Promise<R> {
    const operation = this.beforeNext;
    this.beforeNext = null;
    if (operation) await operation();
    return this.inner.runTransaction(fn);
  }
}

let auth: FakeAuthControls | null = null;

function request(path: string, uid: string, body?: unknown): Request {
  return new Request(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${tokenFor(uid)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function raw(response: Response): Promise<Raw> {
  return { status: response.status, body: await response.json() as Record<string, any> };
}

function begin(label: string): { uid: string; storage: InterleavingStorage; end: () => void } {
  auth = installFakeAuth();
  const storage = new InterleavingStorage(createMemoryStorage());
  setStorageForTests(storage);
  setCaptureChatDependenciesForTests({ llmProviderFor: () => null });
  return {
    uid: uidFor(label),
    storage,
    end: () => {
      setCaptureChatDependenciesForTests(null);
      resetStorageForTests();
      auth?.restore();
      auth = null;
    },
  };
}

async function chat(uid: string, message: string): Promise<Chat> {
  const response = await raw(await chatPost(request('/api/mobile/capture/chat', uid, {
    message,
    timezone: ZONE,
    referenceTime: new Date().toISOString(),
    locale: 'en',
  })));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body as unknown as Chat;
}

function editBody(chatAnswer: Chat, target: { itemId: string } | { seedItemId: string }, text: string) {
  return {
    conversationId: chatAnswer.conversationId,
    edit: {
      proposalId: chatAnswer.proposal.proposalId,
      revision: chatAnswer.proposal.revision,
      target,
      change: { text },
    },
    timezone: ZONE,
    referenceTime: new Date().toISOString(),
    locale: 'en',
  };
}

test('rolling compatibility ends when another device edits after a legacy clarification', async () => {
  const rig = begin('LegacyClarifyThenEdit');
  try {
    const first = await chat(rig.uid, 'Remind me to call Dana tomorrow');
    const item = first.proposal.items[0]!;
    const question = item.clarification!;
    const clarified = await raw(await clarifyPost(request('/api/mobile/capture/clarify', rig.uid, {
      proposalId: first.proposal.proposalId,
      itemId: item.itemId,
      questionId: question.questionId,
      optionId: question.options[0]!.optionId,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    })));
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));

    const edited = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid, editBody(
      { ...first, proposal: clarified.body as unknown as Proposal },
      { itemId: item.itemId },
      'Call Dana about the results',
    ))));
    assert.equal(edited.status, 200, JSON.stringify(edited.body));

    const confirm = await raw(await confirmPost(request('/api/mobile/capture/confirm', rig.uid, {
      proposalId: first.proposal.proposalId,
      itemIds: [item.itemId],
    })));
    assert.equal(confirm.status, 409, JSON.stringify(confirm.body));
    assert.equal(confirm.body.reason, 'proposal_changed');
    assert.equal(confirm.body.state, 'open');
  } finally {
    rig.end();
  }
});

test('clarification CAS refuses an edit committed after its initial read', async () => {
  const rig = begin('ClarifyEditRace');
  try {
    const first = await chat(rig.uid, 'Remind me to call Dana tomorrow');
    const item = first.proposal.items[0]!;
    const question = item.clarification!;
    rig.storage.arm(async () => {
      const edited = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid,
        editBody(first, { itemId: item.itemId }, 'Call Dana about the results'))));
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
    });

    const clarify = await raw(await clarifyPost(request('/api/mobile/capture/clarify', rig.uid, {
      proposalId: first.proposal.proposalId,
      itemId: item.itemId,
      questionId: question.questionId,
      optionId: question.options[0]!.optionId,
      revision: first.proposal.revision,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    })));
    assert.equal(clarify.status, 409, JSON.stringify(clarify.body));
    assert.equal(clarify.body.state, 'open');
    assert.equal(clarify.body.proposal.items[0].title, 'Call Dana about the results');
  } finally {
    rig.end();
  }
});

test('clarification CAS preserves a confirm committed after its initial read', async () => {
  const rig = begin('ClarifyConfirmRace');
  try {
    const first = await chat(rig.uid, 'Remind me to call Dana tomorrow');
    const item = first.proposal.items[0]!;
    const question = item.clarification!;
    const confirmBody = {
      proposalId: first.proposal.proposalId,
      itemIds: [item.itemId],
      revision: first.proposal.revision,
      edits: [{ itemId: item.itemId, title: item.title, resolvedTime: new Date(Date.now() + 86_400_000).toISOString() }],
      idempotencyKey: 'clarify-confirm-race',
    };
    rig.storage.arm(async () => {
      const confirmed = await raw(await confirmPost(request('/api/mobile/capture/confirm', rig.uid, confirmBody)));
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    });

    const clarify = await raw(await clarifyPost(request('/api/mobile/capture/clarify', rig.uid, {
      proposalId: first.proposal.proposalId,
      itemId: item.itemId,
      questionId: question.questionId,
      optionId: question.options[0]!.optionId,
      revision: first.proposal.revision,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    })));
    assert.equal(clarify.status, 409, JSON.stringify(clarify.body));
    assert.equal(clarify.body.state, 'confirmed');
    assert.ok(clarify.body.confirmation, 'the conflict dropped confirmedResult');

    const replay = await raw(await confirmPost(request('/api/mobile/capture/confirm', rig.uid, confirmBody)));
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
  } finally {
    rig.end();
  }
});

test('seed keep transaction creates nothing when an edit wins before its proposal check', async () => {
  const rig = begin('SeedKeepEditRace');
  try {
    const first = await chat(rig.uid, 'Maybe I will travel this summer');
    const seed = first.proposal.seeds[0]!;
    rig.storage.arm(async () => {
      const edited = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid,
        editBody(first, { seedItemId: seed.seedItemId }, 'Maybe I will travel to the coast'))));
      assert.equal(edited.status, 200, JSON.stringify(edited.body));
    });

    const keep = await raw(await seedsPost(request('/api/mobile/seeds', rig.uid, {
      proposalId: first.proposal.proposalId,
      seedItemId: seed.seedItemId,
      revision: first.proposal.revision,
    })));
    assert.equal(keep.status, 409, JSON.stringify(keep.body));
    assert.equal(keep.body.state, 'open');

    const listed = await raw(await seedsGet(request('/api/mobile/seeds', rig.uid)));
    assert.deepEqual(listed.body.items, [], 'a stale keep created an orphan seed');
  } finally {
    rig.end();
  }
});

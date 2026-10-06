import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFirestoreStorage,
  resetFirestoreForTests,
} from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { CAPTURE_PROPOSALS, INTENT_SEEDS, userCol, userDoc } from '../../lib/storage/paths.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { setCaptureChatDependenciesForTests } from '../../lib/services/captureChat/captureChatService.ts';
import { POST as chatPost } from '../../src/app/api/mobile/capture/chat/route.ts';
import { POST as clarifyPost } from '../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as seedsGet, POST as seedsPost } from '../../src/app/api/mobile/seeds/route.ts';
import { StorageCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore.ts';

const BASE = 'http://localhost:3000';
const ZONE = 'America/New_York';
const emulatorSkip = process.env.FIRESTORE_EMULATOR_HOST
  ? false
  : 'FIRESTORE_EMULATOR_HOST is not set; run npm run test:emulator';

type Raw = { status: number; body: Record<string, any> };
type Proposal = {
  proposalId: string;
  revision: number;
  items: Array<{ itemId: string; title: string; clarification?: { questionId: string; options: Array<{ optionId: string }> } | null }>;
  seeds: Array<{ seedItemId: string; summary: string }>;
};
type Chat = { conversationId: string; proposal: Proposal; turns: unknown[] };

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

async function withFirestore(label: string, run: (uid: string) => Promise<void>): Promise<void> {
  resetFirestoreForTests();
  const storage = createFirestoreStorage();
  setStorageForTests(storage);
  const auth: FakeAuthControls = installFakeAuth();
  setCaptureChatDependenciesForTests({ llmProviderFor: () => null });
  const uid = uidFor(`${label}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  try {
    await run(uid);
  } finally {
    setCaptureChatDependenciesForTests(null);
    resetStorageForTests();
    auth.restore();
    await storage.deleteTree(userDoc(uid));
    resetFirestoreForTests();
  }
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

function editBody(answer: Chat, target: { itemId: string } | { seedItemId: string }, text: string) {
  return {
    conversationId: answer.conversationId,
    edit: {
      proposalId: answer.proposal.proposalId,
      revision: answer.proposal.revision,
      target,
      change: { text },
    },
    timezone: ZONE,
    referenceTime: new Date().toISOString(),
    locale: 'en',
  };
}

test('firestore M2b: revision and edit receipt survive a service restart and replay', { skip: emulatorSkip }, async () => {
  await withFirestore('M2bEditReceipt', async (uid) => {
    const first = await chat(uid, 'Call the pharmacy tomorrow at 6pm');
    const item = first.proposal.items[0]!;
    const body = editBody(first, { itemId: item.itemId }, 'Call the pharmacy about the prescription');
    const edited = await raw(await chatPost(request('/api/mobile/capture/chat', uid, body)));
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.proposal.revision, 1);

    resetStorageForTests();
    resetFirestoreForTests();
    setStorageForTests(createFirestoreStorage());
    const replay = await raw(await chatPost(request('/api/mobile/capture/chat', uid, body)));
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body, edited.body);
  });
});

test('firestore M2b: edit-vs-edit and edit-vs-confirm allow one revision winner', { skip: emulatorSkip }, async () => {
  await withFirestore('M2bEditRaces', async (uid) => {
    const first = await chat(uid, 'Call the pharmacy tomorrow at 6pm');
    const item = first.proposal.items[0]!;
    const [left, right] = await Promise.all([
      chatPost(request('/api/mobile/capture/chat', uid, editBody(first, { itemId: item.itemId }, 'Call pharmacy A'))).then(raw),
      chatPost(request('/api/mobile/capture/chat', uid, editBody(first, { itemId: item.itemId }, 'Call pharmacy B'))).then(raw),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);
    const afterEditRace = await new StorageCaptureProposalStore(createFirestoreStorage()).get(first.proposal.proposalId);
    assert.equal(afterEditRace?.contract.revision, 1);

    const second = await chat(uid, 'Email the landlord tomorrow at 7pm');
    const secondItem = second.proposal.items[0]!;
    const [edit, confirm] = await Promise.all([
      chatPost(request('/api/mobile/capture/chat', uid,
        editBody(second, { itemId: secondItem.itemId }, 'Email the landlord about rent'))).then(raw),
      confirmPost(request('/api/mobile/capture/confirm', uid, {
        proposalId: second.proposal.proposalId,
        itemIds: [secondItem.itemId],
        revision: second.proposal.revision,
        idempotencyKey: 'firestore-edit-confirm',
      })).then(raw),
    ]);
    assert.deepEqual([edit.status, confirm.status].sort(), [200, 409]);
    const participant = await createFirestoreStorage().list<Record<string, unknown>>(`${userDoc(uid)}/commitments`);
    assert.ok(participant.length <= 1, `the race created ${participant.length} commitments`);
  });
});

test('firestore M2b: clarify-vs-edit and clarify-vs-confirm preserve the transaction winner', { skip: emulatorSkip }, async () => {
  await withFirestore('M2bClarifyRaces', async (uid) => {
    const first = await chat(uid, 'Remind me to call Dana tomorrow');
    const item = first.proposal.items[0]!;
    const question = item.clarification!;
    const clarifyBody = {
      proposalId: first.proposal.proposalId,
      itemId: item.itemId,
      questionId: question.questionId,
      optionId: question.options[0]!.optionId,
      revision: first.proposal.revision,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    };
    const [clarify, edit] = await Promise.all([
      clarifyPost(request('/api/mobile/capture/clarify', uid, clarifyBody)).then(raw),
      chatPost(request('/api/mobile/capture/chat', uid,
        editBody(first, { itemId: item.itemId }, 'Call Dana about the results'))).then(raw),
    ]);
    assert.deepEqual([clarify.status, edit.status].sort(), [200, 409]);
    const current = await new StorageCaptureProposalStore(createFirestoreStorage()).get(first.proposal.proposalId);
    assert.equal(current?.contract.revision, 1);
    assert.equal(current?.confirmedResult, undefined);

    const second = await chat(uid, 'Remind me to call Sam tomorrow');
    const secondItem = second.proposal.items[0]!;
    const secondQuestion = secondItem.clarification!;
    const [clarified, confirmed] = await Promise.all([
      clarifyPost(request('/api/mobile/capture/clarify', uid, {
        proposalId: second.proposal.proposalId,
        itemId: secondItem.itemId,
        questionId: secondQuestion.questionId,
        optionId: secondQuestion.options[0]!.optionId,
        revision: second.proposal.revision,
        timezone: ZONE,
        referenceTime: new Date().toISOString(),
      })).then(raw),
      confirmPost(request('/api/mobile/capture/confirm', uid, {
        proposalId: second.proposal.proposalId,
        itemIds: [secondItem.itemId],
        revision: second.proposal.revision,
        edits: [{
          itemId: secondItem.itemId,
          title: secondItem.title,
          resolvedTime: new Date(Date.now() + 86_400_000).toISOString(),
        }],
        idempotencyKey: 'firestore-clarify-confirm',
      })).then(raw),
    ]);
    assert.deepEqual([clarified.status, confirmed.status].sort(), [200, 409]);
    const after = await new StorageCaptureProposalStore(createFirestoreStorage()).get(second.proposal.proposalId);
    assert.equal(after?.contract.revision, 1);
    if (confirmed.status === 200) assert.ok(after?.confirmedResult, 'the clarification dropped confirmedResult');
  });
});

test('firestore M2b: proposal timezone and correction spans round-trip', { skip: emulatorSkip }, async () => {
  await withFirestore('M2bMetadata', async (uid) => {
    const proposalId = `proposal-${Date.now().toString(36)}`;
    const store = new StorageCaptureProposalStore(createFirestoreStorage());
    await store.put({
      scopeId: uid,
      contract: {
        version: 'v1',
        proposalId,
        revision: 3,
        status: 'proposed',
        items: [{
          itemId: 'item-1',
          title: 'Call Dana',
          resolvedTime: null,
          needsClarification: false,
          priority: 'normal',
          priorityEstimated: false,
          corrections: [{ id: 'correction-1', from: 'Dena', to: 'Dana' }],
        }],
        seeds: [],
        provenance: { requestedEngine: 'model', executedEngine: 'gemini', fallbackUsed: false },
      },
      commandsByItemId: new Map([['item-1', []]]),
      timezone: ZONE,
      correctionSpans: { 'correction-1': { itemId: 'item-1', index: 5, length: 4 } },
      structuredEditSources: {
        'item-1': { ordinal: 0, originalText: 'Call Dena', rawText: 'Call Dena', fields: { text: true, corrections: true } },
      },
      latestChatTouchedIds: ['item-1'],
      keptSeedItemIds: ['seed-kept-1'],
    });
    resetFirestoreForTests();
    const read = await new StorageCaptureProposalStore(createFirestoreStorage()).get(proposalId);
    assert.equal(read?.timezone, ZONE);
    assert.deepEqual(read?.correctionSpans, { 'correction-1': { itemId: 'item-1', index: 5, length: 4 } });
    assert.deepEqual(read?.structuredEditSources, {
      'item-1': { ordinal: 0, originalText: 'Call Dena', rawText: 'Call Dena', fields: { text: true, corrections: true } },
    });
    assert.deepEqual(read?.latestChatTouchedIds, ['item-1']);
    assert.deepEqual(read?.keptSeedItemIds, ['seed-kept-1']);
    assert.equal(read?.contract.revision, 3);
  });
});

test('firestore M2b: seed keep receipt and seed are one durable replayable claim', { skip: emulatorSkip }, async () => {
  await withFirestore('M2bSeedReceipt', async (uid) => {
    const raced = await chat(uid, 'Maybe I will learn Italian this year');
    const racedSeed = raced.proposal.seeds[0]!;
    const [racedKeep, racedEdit] = await Promise.all([
      seedsPost(request('/api/mobile/seeds', uid, {
        proposalId: raced.proposal.proposalId,
        seedItemId: racedSeed.seedItemId,
        revision: raced.proposal.revision,
        idempotencyKey: 'firestore-seed-race',
      })).then(raw),
      chatPost(request('/api/mobile/capture/chat', uid,
        editBody(raced, { seedItemId: racedSeed.seedItemId }, 'Maybe I will learn Spanish this year'))).then(raw),
    ]);
    const afterRace = await new StorageCaptureProposalStore(createFirestoreStorage()).get(raced.proposal.proposalId);
    const rowsAfterRace = await createFirestoreStorage().list<Record<string, any>>(userCol(uid, INTENT_SEEDS));
    if (racedKeep.status === 201) {
      assert.equal(racedEdit.status, 400, JSON.stringify(racedEdit.body));
      assert.equal(racedEdit.body.reason, 'edit_invalid');
      assert.equal(afterRace?.contract.revision, 0);
      assert.equal(afterRace?.contract.seeds.find((candidate) => candidate.seedItemId === racedSeed.seedItemId)?.summary, racedSeed.summary);
      assert.equal(rowsAfterRace.length, 1, 'the winning keep did not commit its seed');
      assert.equal(rowsAfterRace[0]?.data.summary, racedSeed.summary, 'the kept row differs from the proposal that was kept');
    } else {
      assert.equal(racedEdit.status, 200, JSON.stringify(racedEdit.body));
      assert.equal(racedKeep.status, 409, JSON.stringify(racedKeep.body));
      assert.equal(racedKeep.body.reason, 'proposal_changed');
      assert.equal(racedKeep.body.state, 'open');
      assert.equal(afterRace?.contract.revision, 1);
      assert.equal(afterRace?.contract.seeds.find((candidate) => candidate.seedItemId === racedSeed.seedItemId)?.summary, 'Maybe I will learn Spanish this year');
      assert.equal(rowsAfterRace.length, 0, 'the losing keep committed the stale seed');
    }

    const first = await chat(uid, 'Maybe I will travel this summer');
    const seed = first.proposal.seeds[0]!;
    const body = {
      proposalId: first.proposal.proposalId,
      seedItemId: seed.seedItemId,
      revision: first.proposal.revision,
      idempotencyKey: 'firestore-seed-keep',
    };
    const kept = await raw(await seedsPost(request('/api/mobile/seeds', uid, body)));
    assert.equal(kept.status, 201, JSON.stringify(kept.body));

    resetStorageForTests();
    resetFirestoreForTests();
    setStorageForTests(createFirestoreStorage());
    const replay = await raw(await seedsPost(request('/api/mobile/seeds', uid, body)));
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
    assert.deepEqual(replay.body.seed, kept.body.seed);

    const listed = await raw(await seedsGet(request('/api/mobile/seeds', uid)));
    assert.equal(listed.body.items.length, rowsAfterRace.length + 1);
    const proposalRows = await createFirestoreStorage().list<Record<string, any>>(userCol(uid, CAPTURE_PROPOSALS));
    const keptProposal = proposalRows.find((row) => row.data.proposalId === first.proposal.proposalId)?.data;
    assert.equal(keptProposal?.contract.revision, 0);
    assert.equal(keptProposal?.seedKeepReceipt.seedItemId, seed.seedItemId);
    assert.deepEqual(keptProposal?.keptSeedItemIds, [seed.seedItemId]);
    const seedRows = await createFirestoreStorage().list(userCol(uid, INTENT_SEEDS));
    assert.equal(seedRows.length, rowsAfterRace.length + 1);
  });
});

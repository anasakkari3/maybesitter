import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createMemoryStorage,
  resetStorageForTests,
  setStorageForTests,
  type ListOptions,
  type StorageAdapter,
  type StorageTransaction,
} from '../../lib/storage/index.ts';
import { installFakeAuth, tokenFor, uidFor, type FakeAuthControls } from '../support/fakeAuth.ts';
import { boundedTurns, setCaptureChatDependenciesForTests } from '../../lib/services/captureChat/captureChatService.ts';
import { POST as chatPost } from '../../src/app/api/mobile/capture/chat/route.ts';
import { POST as clarifyPost } from '../../src/app/api/mobile/capture/clarify/route.ts';
import { POST as confirmPost } from '../../src/app/api/mobile/capture/confirm/route.ts';
import { GET as seedsGet, POST as seedsPost } from '../../src/app/api/mobile/seeds/route.ts';
import { captureConversationPath } from '../../lib/services/captureChat/conversationStore.ts';
import { StorageCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore.ts';
import {
  CALL_AND_TRAVEL,
  DOCTOR_AND_TRAVEL,
  LATER,
  REFERENCE,
  TOMORROW,
  at,
  assertUnderstoodValid,
  assertEditInvalid,
  beginModel as beginGateModel,
  beginRules as beginGateRules,
  chat as gateChat,
  clarifyRaw,
  confirmRaw,
  currentStorage,
  edit as gateEdit,
  editOf,
  editRaw as gateEditRaw,
  end as endGate,
  itemById,
  itemWith,
  keepSeedRaw,
  keptSeeds,
  modelFirstAnswer,
  modelRefAnswer,
  modelCalls,
  modelCorrections,
  modelItem,
  revisionOf,
  savedCommitments,
  seedWith,
  takeModelDown,
  type Answer,
  type Proposal as GateProposal,
} from '../acceptance/m2b/support.ts';
import { parseChatModelAnswer } from '../../lib/services/captureChat/chatPrompt.ts';
import { geminiChatSchemaFor } from '../../src/extraction/ollamaExtractionSchema.ts';

const BASE = 'http://localhost:3000';
const ZONE = 'Asia/Jerusalem';

type Raw = { status: number; body: Record<string, any> };
type Proposal = {
  proposalId: string;
  revision: number;
  items: Array<{ itemId: string; title: string; clarification?: { questionId: string; options: Array<{ optionId: string }> } | null }>;
  seeds: Array<{ seedItemId: string; summary: string }>;
  removedItems?: Array<{ itemId?: string; seedItemId?: string; kind: string; text: string }>;
};
type Chat = { conversationId: string; proposal: Proposal; turns: Array<{ role: string; text: string }> };

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

test('seed keep/edit race creates nothing when the edit wins first', async () => {
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
    assert.equal(keep.body.reason, 'proposal_changed');
    assert.equal(keep.body.state, 'open');
    assert.equal(keep.body.proposal.revision, 1);
    assert.equal(keep.body.proposal.seeds.find((candidate: { seedItemId: string }) => candidate.seedItemId === seed.seedItemId)?.summary, 'Maybe I will travel to the coast');

    const listed = await raw(await seedsGet(request('/api/mobile/seeds', rig.uid)));
    assert.deepEqual(listed.body.items, [], 'a stale keep created an orphan seed');
  } finally {
    rig.end();
  }
});

test('seed keep/edit race preserves the kept proposal when the keep wins first', async () => {
  const rig = begin('SeedEditKeepRace');
  try {
    const first = await chat(rig.uid, 'Maybe I will travel this summer');
    const seed = first.proposal.seeds[0]!;
    rig.storage.arm(async () => {
      const kept = await raw(await seedsPost(request('/api/mobile/seeds', rig.uid, {
        proposalId: first.proposal.proposalId,
        seedItemId: seed.seedItemId,
        revision: first.proposal.revision,
      })));
      assert.equal(kept.status, 201, JSON.stringify(kept.body));
      assert.equal(kept.body.seed.summary, seed.summary);
    });

    const edited = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid,
      editBody(first, { seedItemId: seed.seedItemId }, 'Maybe I will travel to the coast'))));
    assert.equal(edited.status, 400, JSON.stringify(edited.body));
    assert.equal(edited.body.reason, 'edit_invalid');

    const listed = await raw(await seedsGet(request('/api/mobile/seeds', rig.uid)));
    assert.equal(listed.body.items.length, 1, JSON.stringify(listed.body));
    assert.equal(listed.body.items[0]?.summary, seed.summary);
    const proposal = await new StorageCaptureProposalStore(rig.storage).get(first.proposal.proposalId);
    assert.equal(proposal?.contract.revision, 0);
    assert.equal(proposal?.contract.seeds.find((candidate) => candidate.seedItemId === seed.seedItemId)?.summary, seed.summary);
  } finally {
    rig.end();
  }
});

test('a seed keep is revision-neutral: same-revision confirm, another keep, and legacy confirm all work', async () => {
  let uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const item = itemWith(first.proposal, 'اتصل بأمي');
    const seed = seedWith(first.proposal, 'أسافر');
    const keep = await keepSeedRaw(uid, {
      proposalId: first.proposal!.proposalId,
      seedItemId: seed.seedItemId,
      revision: revisionOf(first.proposal),
    });
    assert.equal(keep.status, 201, JSON.stringify(keep.body));
    const confirm = await confirmRaw(uid, {
      proposalId: first.proposal!.proposalId,
      itemIds: [item.itemId],
      revision: revisionOf(first.proposal),
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  } finally {
    endGate();
  }

  uid = beginGateRules();
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي، وعم بفكر أتعلم العبرية', { locale: 'ar' });
    assert.equal(first.proposal?.seeds.length, 2, JSON.stringify(first.proposal));
    for (const seed of first.proposal!.seeds) {
      const keep = await keepSeedRaw(uid, {
        proposalId: first.proposal!.proposalId,
        seedItemId: seed.seedItemId,
        revision: revisionOf(first.proposal),
      });
      assert.equal(keep.status, 201, JSON.stringify(keep.body));
    }
    assert.equal((await keptSeeds(uid)).length, 2);
  } finally {
    endGate();
  }

  uid = beginGateRules();
  try {
    const first = await gateChat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const seed = seedWith(first.proposal, 'أسافر');
    assert.equal((await keepSeedRaw(uid, {
      proposalId: first.proposal!.proposalId,
      seedItemId: seed.seedItemId,
      revision: 0,
    })).status, 201);
    const clarified = await clarifyRaw(uid, first.proposal!, doctor, {
      optionId: doctor.clarification!.options[0]!.optionId,
    }, { revision: 0 });
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
  } finally {
    endGate();
  }

  uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const item = itemWith(first.proposal, 'اتصل بأمي');
    const seed = seedWith(first.proposal, 'أسافر');
    assert.equal((await keepSeedRaw(uid, {
      proposalId: first.proposal!.proposalId,
      seedItemId: seed.seedItemId,
    })).status, 201);
    const confirm = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [item.itemId] });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
  } finally {
    endGate();
  }
});

async function editThenAddBread(uid: string, first: Answer, locale: 'ar' | 'en'): Promise<Answer> {
  const call = itemWith(first.proposal, 'اتصل بأمي');
  const travel = seedWith(first.proposal, 'أسافر');
  const words = await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }), { locale });
  const kind = await gateEdit(uid, first.conversationId, editOf(words, { seedItemId: travel.seedItemId }, { kind: 'idea' }), { locale });
  const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale });
  assert.equal(itemById(next.proposal, call.itemId).title, 'اتصل بأختي');
  assert.equal(next.proposal!.seeds.find((candidate) => candidate.seedItemId === travel.seedItemId)?.kind, 'idea');
  assert.ok(next.proposal!.items.some((candidate) => candidate.title.includes('اشتري خبز')), JSON.stringify(next.proposal));
  assert.ok(!next.proposal!.seeds.some((candidate) => /غيّر|Change/.test(candidate.summary)), 'a synthetic edit turn became a seed');
  assert.ok(kind.turns.some((turn) => turn.role === 'user'), 'the display turn disappeared');
  return next;
}

for (const locale of ['ar', 'en'] as const) {
  test(`structured words and kind edits survive the next rules message (${locale}), while edit turns are not evidence`, async () => {
    const uid = beginGateRules();
    try {
      const first = await gateChat(uid, CALL_AND_TRAVEL, { locale });
      const next = await editThenAddBread(uid, first, locale);
      const call = itemWith(next.proposal, 'اتصل بأختي');
      const confirmed = await confirmRaw(uid, {
        proposalId: next.proposal!.proposalId,
        itemIds: [call.itemId],
        revision: revisionOf(next.proposal),
      });
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.ok((await savedCommitments(uid)).some((saved) => saved.title === 'اتصل بأختي'));
    } finally {
      endGate();
    }
  });
}

test('structured words and kind edits survive the next model message with the existing fake model', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      locked: [{ ref: 'i1', op: 'keep' }, { ref: 's1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '18:00')],
    }),
  );
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    await editThenAddBread(uid, first, 'ar');
  } finally {
    endGate();
  }
});

test('a structured time edit survives a later additive rules message', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const moved = await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, {
      time: { at: at(LATER, '20:00'), timeZone: 'Asia/Jerusalem' },
    }));
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', {
      conversationId: first.conversationId,
      locale: 'ar',
    });
    assert.equal(itemById(next.proposal, call.itemId).resolvedTime, at(LATER, '20:00'));
    assert.equal(revisionOf(moved.proposal), 1);
  } finally {
    endGate();
  }
});

test('legacy clarification compatibility chains through two questions, then confirms', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, 'Remind me to call Dana tomorrow and email Sam on Friday', { locale: 'en' });
    const asking = first.proposal!.items.filter((item) => item.clarification);
    assert.equal(asking.length, 2, JSON.stringify(first.proposal));
    const one = await clarifyRaw(uid, first.proposal!, asking[0]!, { optionId: asking[0]!.clarification!.options[0]!.optionId });
    assert.equal(one.status, 200, JSON.stringify(one.body));
    const afterOne = one.body as GateProposal;
    const second = afterOne.items.find((item) => item.itemId === asking[1]!.itemId)!;
    const two = await clarifyRaw(uid, afterOne, second, { optionId: second.clarification!.options[0]!.optionId });
    assert.equal(two.status, 200, JSON.stringify(two.body));
    const afterTwo = two.body as GateProposal;
    const confirm = await confirmRaw(uid, { proposalId: afterTwo.proposalId, itemIds: afterTwo.items.map((item) => item.itemId) });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    assert.equal((await savedCommitments(uid)).length, 2);
  } finally {
    endGate();
  }
});

test('a revisioned clarification never arms legacy confirm, and an explicit stale revision never consumes the legacy marker', async () => {
  let uid = beginGateRules();
  try {
    const first = await gateChat(uid, 'Remind me to call Dana tomorrow', { locale: 'en' });
    const item = first.proposal!.items[0]!;
    const clarified = await clarifyRaw(uid, first.proposal!, item, { optionId: item.clarification!.options[0]!.optionId }, { revision: 0 });
    assert.equal(clarified.status, 200);
    const confirm = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [item.itemId] });
    assert.equal(confirm.status, 409, JSON.stringify(confirm.body));
  } finally {
    endGate();
  }

  uid = beginGateRules();
  try {
    const first = await gateChat(uid, 'Remind me to call Dana tomorrow', { locale: 'en' });
    const item = first.proposal!.items[0]!;
    assert.equal((await clarifyRaw(uid, first.proposal!, item, { optionId: item.clarification!.options[0]!.optionId })).status, 200);
    const confirm = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [item.itemId], revision: 0 });
    assert.equal(confirm.status, 409, JSON.stringify(confirm.body));
  } finally {
    endGate();
  }
});

test('a delayed edit retry after confirmation is a confirmed 409, not a replay', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const item = itemWith(first.proposal, 'اتصل بأمي');
    const spec = editOf(first, { itemId: item.itemId }, { text: 'اتصل بأختي' });
    const edited = await gateEdit(uid, first.conversationId, spec);
    assert.equal((await confirmRaw(uid, {
      proposalId: edited.proposal!.proposalId,
      itemIds: [item.itemId],
      revision: revisionOf(edited.proposal),
    })).status, 200);
    const retry = await gateEditRaw(uid, first.conversationId, spec);
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.state, 'confirmed');
  } finally {
    endGate();
  }
});

test('legacy confirmed data refuses an edit, and invalid zones or seed-kind-plus-time patches are atomic refusals', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const item = itemWith(first.proposal, 'اتصل بأمي');
    const seed = seedWith(first.proposal, 'أسافر');
    const proposalPath = currentStorage().pathsForTests().find((path) => path.includes(first.proposal!.proposalId))!;
    const document = await currentStorage().get<Record<string, unknown>>(proposalPath);
    await currentStorage().set(proposalPath, { ...document, confirmedResult: { success: true } });
    const confirmed = await gateEditRaw(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { text: 'اتصل بأختي' }));
    assert.equal(confirmed.status, 409, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.state, 'confirmed');

    delete (document as Record<string, unknown>).confirmedResult;
    await currentStorage().set(proposalPath, document!);
    assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(first, { itemId: item.itemId }, {
      time: { at: null, timeZone: 'Mars/Phobos' },
    })), 'a null instant with an invalid zone');
    assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(first, { itemId: item.itemId }, {
      kind: 'idea',
      time: { at: at(LATER, '16:00'), timeZone: 'Asia/Jerusalem' },
    })), 'item to seed with time');
    assert.ok(seed.seedItemId);
  } finally {
    endGate();
  }
});

test('an exact seed-keep retry replays after a structured edit', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const item = itemWith(first.proposal, 'اتصل بأمي');
    const seed = seedWith(first.proposal, 'أسافر');
    const body = { proposalId: first.proposal!.proposalId, seedItemId: seed.seedItemId, revision: 0 };
    assert.equal((await keepSeedRaw(uid, body)).status, 201);
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { text: 'اتصل بأختي' }));
    const replay = await keepSeedRaw(uid, body);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
  } finally {
    endGate();
  }
});

test('structured-edit user content is not emitted through console.info', async () => {
  const uid = beginGateRules();
  const seen: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => { seen.push(args); };
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const item = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, { text: 'اتصل بسري للغاية' }));
    assert.ok(!JSON.stringify(seen).includes('بسري للغاية'), JSON.stringify(seen));
  } finally {
    console.info = original;
    endGate();
  }
});

test('correction span shifts, combined text+reject refusal, and the three-correction cap are independently guarded', async () => {
  let uid = beginGateModel(modelFirstAnswer('راجع القائمة.', 'propose', [
    modelItem('اطلع عالسوق وجيب خبز', TOMORROW, '17:00', modelCorrections(['الطلع', 'اطلع'], ['خبس', 'خبز'])),
  ]));
  try {
    const first = await gateChat(uid, 'لازم الطلع عالسوق وجيب خبس بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    const item = itemWith(first.proposal, 'عالسوق');
    const corrections = item.corrections!;
    const again = await gateChat(uid, 'لازم الطلع عالسوق وجيب خبس بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    const againItem = itemWith(again.proposal, 'عالسوق');
    assertEditInvalid(await gateEditRaw(uid, again.conversationId, editOf(again, { itemId: againItem.itemId }, {
      text: 'اطلع عالسوق وجيب خبز هلق',
      rejectCorrectionIds: [againItem.corrections![0]!.id],
    })), 'text that leaves the correction span plus reject');

    const both = await gateEdit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, {
      rejectCorrectionIds: corrections.map((correction) => correction.id),
    }));
    assert.equal(itemById(both.proposal, item.itemId).title, 'الطلع عالسوق وجيب خبس');
    takeModelDown();
    const afterMessage = await gateChat(uid, 'وكمان لازم اشتري حليب بكرا الساعة 6 المسا', {
      conversationId: first.conversationId,
      locale: 'ar',
    });
    const carried = itemById(afterMessage.proposal, item.itemId);
    assert.equal(carried.title, 'الطلع عالسوق وجيب خبس');
    assert.deepEqual(carried.corrections ?? [], []);
  } finally {
    endGate();
  }

  uid = beginGateModel(modelFirstAnswer('راجع القائمة.', 'propose', [
    modelItem('اطلع عالسوق جيب خبز حليب بيض', TOMORROW, '17:00', modelCorrections(
      ['الطلع', 'اطلع'], ['خبس', 'خبز'], ['حليف', 'حليب'], ['بيظ', 'بيض'],
    )),
  ]));
  try {
    const first = await gateChat(uid, 'لازم الطلع عالسوق جيب خبس حليف بيظ بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    assert.equal(itemWith(first.proposal, 'عالسوق').corrections?.length, 3, JSON.stringify(first.proposal));
  } finally {
    endGate();
  }
});

test('edit transaction follows the conversation pointer and reports a concurrent deletion as 404', async () => {
  let rig = begin('EditConversationPointerRace');
  try {
    const first = await chat(rig.uid, 'Remind me to call Dana tomorrow at 5pm');
    const item = first.proposal.items[0]!;
    let newer: Chat | null = null;
    rig.storage.arm(async () => {
      const response = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid, {
        conversationId: first.conversationId,
        message: 'and remind me to buy bread tomorrow at 6pm',
        timezone: ZONE,
        referenceTime: new Date().toISOString(),
        locale: 'en',
      })));
      assert.equal(response.status, 200, JSON.stringify(response.body));
      newer = response.body as Chat;
    });
    const edit = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid,
      editBody(first, { itemId: item.itemId }, 'Call Dana about the results'))));
    assert.equal(edit.status, 409, JSON.stringify(edit.body));
    assert.equal(edit.body.state, 'open');
    assert.equal(edit.body.answer.proposal.proposalId, newer!.proposal.proposalId);
    assert.equal(edit.body.answer.turns.length, newer!.turns.length);
  } finally {
    rig.end();
  }

  rig = begin('EditConversationDeletedRace');
  try {
    const first = await chat(rig.uid, 'Remind me to call Dana tomorrow at 5pm');
    const item = first.proposal.items[0]!;
    rig.storage.arm(async () => {
      await rig.storage.delete(captureConversationPath(rig.uid, first.conversationId));
    });
    const edit = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid,
      editBody(first, { itemId: item.itemId }, 'Call Dana about the results'))));
    assert.equal(edit.status, 404, JSON.stringify(edit.body));
    assert.equal(edit.body.reason, 'conversation_not_found');
  } finally {
    rig.end();
  }
});

test('D1 server locks keep every structured edit while later model additions remain', async () => {
  let uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [modelItem('اتصل بأمي', null, null)] },
    { reply: 'حدّثت الوقت.', action: 'update', locked: [{ ref: 'i1', op: 'keep' }], open: [], added: [] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const timed = await gateChat(uid, 'بكرا الساعة 5 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(timed.proposal, call.itemId).title, 'اتصل بأختي');
    assert.equal(itemById(timed.proposal, call.itemId).resolvedTime, null);
  } finally {
    endGate();
  }

  uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [modelItem('اتصل بأمي', TOMORROW, '16:00')] },
    { reply: 'حدّثت الوقت.', action: 'update', locked: [{ ref: 'i1', op: 'keep' }], open: [], added: [] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 4 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, {
      time: { at: at(LATER, '17:00'), timeZone: ZONE },
    }));
    const moved = await gateChat(uid, 'لا، الساعة 7 أحسن', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(moved.proposal, call.itemId).resolvedTime, at(LATER, '17:00'));
  } finally {
    endGate();
  }

  uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })] },
    { reply: 'تمام.', action: 'update', locked: [{ ref: 's1', op: 'keep' }], open: [], added: [modelItem('اشتري خبز', TOMORROW, '18:00')] },
  );
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    await gateEdit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'idea' }));
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.seeds.find((seed) => seed.seedItemId === travel.seedItemId)?.kind, 'idea');
  } finally {
    endGate();
  }
});

test('D1 rules path keeps edited words when a later clarification supplies the time', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const timed = await gateChat(uid, 'بكرا الساعة 5 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(timed.proposal, call.itemId).title, 'اتصل بأختي');
    assert.equal(itemById(timed.proposal, call.itemId).resolvedTime, at(TOMORROW, '17:00'));
  } finally {
    endGate();
  }
});

for (const text of ['study on Tuesday and Thursday at 7 PM', 'ادرس يوم الثلاثاء والخميس الساعة 7 المسا']) {
  test(`D2 carries an edit on its own repeated occurrence: ${text}`, async () => {
    const uid = beginGateRules();
    try {
      const first = await gateChat(uid, text, { locale: text.startsWith('study') ? 'en' : 'ar' });
      assert.equal(first.proposal!.items.length, 2, JSON.stringify(first.proposal));
      const second = first.proposal!.items[1]!;
      await gateEdit(uid, first.conversationId, editOf(first, { itemId: second.itemId }, { text: 'study EDITED' }));
      const next = await gateChat(uid, 'and buy bread tomorrow at 6pm', { conversationId: first.conversationId, locale: 'en' });
      assert.equal(next.proposal!.items.length, 3, JSON.stringify(next.proposal));
      assert.equal(itemById(next.proposal, second.itemId).title, 'study EDITED');
      assert.equal(new Set(next.proposal!.items.filter((item) => !/bread/.test(item.title)).map((item) => item.resolvedTime)).size, 2);
    } finally {
      endGate();
    }
  });
}

test('N1/N2 ref carry never replaces a newly inserted item and removes a lock visibly', async () => {
  const call = () => modelItem('اتصل بأمي', TOMORROW, '17:00');
  const bill = () => modelItem('ادفع الفاتورة', TOMORROW, '18:00');
  const bread = () => modelItem('اشتري خبز', TOMORROW, '19:00');
  for (const edited of ['اتصل بأمي', 'ادفع الفاتورة'] as const) {
    const lockedRef = edited === 'اتصل بأمي' ? 'i1' : 'i2';
    const openRef = edited === 'اتصل بأمي' ? 'i2' : 'i1';
    const uid = beginGateModel(
      { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [call(), bill()] },
      { reply: 'أضفت الخبز.', action: 'update', locked: [{ ref: lockedRef, op: 'keep' }], open: [{ ref: openRef, op: 'keep' }], added: [bread()] },
    );
    try {
      const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' });
      const target = itemWith(first.proposal, edited);
      await gateEdit(uid, first.conversationId, editOf(first, { itemId: target.itemId }, { text: `${edited} EDITED` }));
      const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
      assert.deepEqual(
        new Set(next.proposal!.items.map((item) => item.title)),
        new Set([edited === 'اتصل بأمي' ? 'اتصل بأمي EDITED' : 'اتصل بأمي', edited === 'ادفع الفاتورة' ? 'ادفع الفاتورة EDITED' : 'ادفع الفاتورة', 'اشتري خبز']),
        JSON.stringify(next.proposal),
      );
    } finally {
      endGate();
    }
  }

  const uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [call(), bill()] },
    { reply: 'شلت الاتصال وأضفت الخبز.', action: 'update', locked: [{ ref: 'i1', op: 'remove' }], open: [{ ref: 'i2', op: 'keep' }], added: [bread()] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' });
    const target = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: target.itemId }, { text: 'اتصل بأمي EDITED' }));
    const next = await gateChat(uid, 'خلص ما بدي اتصل، بس لازم اشتري خبز بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.deepEqual(new Set(next.proposal!.items.map((item) => item.title)), new Set(['اشتري خبز', 'ادفع الفاتورة']), JSON.stringify(next.proposal));
    assert.deepEqual((next.proposal as GateProposal & Proposal).removedItems?.map((item) => item.text), ['اتصل بأمي EDITED']);
  } finally {
    endGate();
  }
});

test('D4/N2d synthetic edit turns cannot evict real evidence by count or length', () => {
  const original = `capture ${'x'.repeat(1855)}`;
  const editWords = `Change ${'y'.repeat(108)}`;
  const kept = boundedTurns([
    { role: 'user', text: original },
    { role: 'assistant', text: 'review' },
    { role: 'user', text: editWords, evidence: false },
    { role: 'assistant', text: 'updated' },
    { role: 'user', text: 'buy bread tomorrow at 6pm' },
  ], 11);
  assert.ok(kept.some((turn) => turn.text === original));
});

test('D4/N2f/N3c five edits and two later rules messages keep every edited item without phantom edit seeds', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    let current = first;
    for (const title of ['اتصل بأختي', 'اتصل بأخي', 'اتصل بأختي اليوم', 'اتصل بأخي اليوم', 'اتصل بأختي']) {
      current = await gateEdit(uid, first.conversationId, editOf(current, { itemId: call.itemId }, { text: title }));
    }
    const one = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const two = await gateChat(uid, 'وكمان لازم اشتري حليب بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(one.proposal, call.itemId).title, 'اتصل بأختي');
    assert.equal(itemById(two.proposal, call.itemId).title, 'اتصل بأختي');
    assert.ok(!two.proposal!.seeds.some((seed) => /غيّر|Change/.test(seed.summary)), JSON.stringify(two.proposal));
  } finally {
    endGate();
  }
});

test('R8b seven structured edits cannot evict the original capture evidence', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    let current = first;
    for (let index = 0; index < 7; index += 1) {
      current = await gateEdit(uid, first.conversationId, editOf(current, { itemId: call.itemId }, { text: `اتصل بأختي ${index + 1}` }));
    }
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(next.proposal, call.itemId).title, 'اتصل بأختي 7');
    assert.ok(next.proposal!.items.some((item) => item.title.includes('اشتري خبز')), JSON.stringify(next.proposal));
    assert.ok(next.turns.some((turn) => turn.text === CALL_AND_TRAVEL), 'the original capture turn was evicted');
  } finally {
    endGate();
  }
});

test('D5 a seed-kind edit survives a model list edit and the seed reaches currentProposal', async () => {
  const prompts: string[] = [];
  const answers = [
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelRefAnswer('غيّرت الوقت.', 'update', {
      locked: [{ ref: 's1', op: 'keep' }],
      open: [{ ref: 'i1', op: 'update', fields: modelItem('اتصل بأمي', TOMORROW, '19:00') }],
    }),
  ];
  const uid = beginGateModel(...answers);
  setCaptureChatDependenciesForTests({ llmProviderFor: () => async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)]);
  } });
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const kind = await gateEdit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'idea' }));
    const next = await gateChat(uid, `غيّر «${call.title}» للساعة 7`, { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.seeds.find((seed) => seed.seedItemId === travel.seedItemId)?.kind, 'idea');
    assert.ok(prompts[1]!.includes('"kind":"idea"'), 'the edited seed was absent from the model currentProposal');
    assert.equal(revisionOf(kind.proposal), 1);
  } finally {
    endGate();
  }
});

test('D6 a revisionless seed keep is accepted at the active legacy clarification revision', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const travel = seedWith(first.proposal, 'أسافر');
    const clarified = await clarifyRaw(uid, first.proposal!, doctor, { optionId: doctor.clarification!.options[0]!.optionId });
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
    const keep = await keepSeedRaw(uid, { proposalId: first.proposal!.proposalId, seedItemId: travel.seedItemId });
    assert.equal(keep.status, 201, JSON.stringify(keep.body));
  } finally {
    endGate();
  }
});

test('D7 a kept seed cannot also be edited into a commitment', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    assert.equal((await keepSeedRaw(uid, { proposalId: first.proposal!.proposalId, seedItemId: travel.seedItemId, revision: 0 })).status, 201);
    assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, {
      kind: 'commitment',
      time: { at: at(LATER, '17:00'), timeZone: ZONE },
    })), 'a seed already kept from this proposal');
    assert.equal((await keptSeeds(uid)).length, 1);
  } finally {
    endGate();
  }
});

test('R11a/R11c either of two kept seeds is refused as a commitment edit', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي، وعم بفكر أتعلم العبرية', { locale: 'ar' });
    assert.equal(first.proposal!.seeds.length, 2, JSON.stringify(first.proposal));
    for (const seed of first.proposal!.seeds) {
      assert.equal((await keepSeedRaw(uid, {
        proposalId: first.proposal!.proposalId,
        seedItemId: seed.seedItemId,
        revision: revisionOf(first.proposal),
      })).status, 201);
    }
    for (const seed of first.proposal!.seeds) {
      assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(first, { seedItemId: seed.seedItemId }, {
        kind: 'commitment',
        time: { at: at(LATER, '17:00'), timeZone: ZONE },
      })), `kept seed ${seed.summary}`);
    }
    assert.equal((await keptSeeds(uid)).length, 2);
  } finally {
    endGate();
  }
});

test('N5 a seed kept on an earlier proposal cannot be promoted when the same words are offered again', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const firstTravel = seedWith(first.proposal, 'أسافر');
    assert.equal((await keepSeedRaw(uid, {
      proposalId: first.proposal!.proposalId,
      seedItemId: firstTravel.seedItemId,
      revision: revisionOf(first.proposal),
    })).status, 201);
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const offeredAgain = seedWith(next.proposal, 'أسافر');
    assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(next, { seedItemId: offeredAgain.seedItemId }, {
      kind: 'commitment',
      time: { at: at(LATER, '17:00'), timeZone: ZONE },
    })), 'the words were already kept from the previous proposal');
    assert.equal((await keptSeeds(uid)).length, 1);
  } finally {
    endGate();
  }
});

test('M14 seed words plus time without commitment kind is edit_invalid', async () => {
  const uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, {
      text: 'أسافر عالبحر',
      time: { at: at(LATER, '17:00'), timeZone: ZONE },
    })), 'seed words plus a silently discarded time');
  } finally {
    endGate();
  }
});

test('N2b a structured edit display turn is never included in the model prompt', async () => {
  const prompts: string[] = [];
  const answers = [
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [modelItem('اتصل بأمي', TOMORROW, '17:00')] },
    { reply: 'أضفت الخبز.', action: 'update', locked: [{ ref: 'i1', op: 'keep' }], open: [], added: [modelItem('اشتري خبز', TOMORROW, '18:00')] },
  ];
  const uid = beginGateModel(...answers);
  setCaptureChatDependenciesForTests({ llmProviderFor: () => async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify(answers[Math.min(prompts.length - 1, answers.length - 1)]);
  } });
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.ok(!prompts[1]!.includes('غيّر «اتصل بأمي» لـ «اتصل بأختي»'), prompts[1]);
    assert.ok(prompts[1]!.includes('"ref":"i1","locked":true'), 'the prompt did not carry the server ref and lock');
  } finally {
    endGate();
  }
});

test('N5b/N5c independent keep, clarify and edit receipts replay after the other writers', async () => {
  let uid = beginGateRules();
  try {
    const first = await gateChat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const travel = seedWith(first.proposal, 'أسافر');
    const keepBody = { proposalId: first.proposal!.proposalId, seedItemId: travel.seedItemId, revision: 0 };
    assert.equal((await keepSeedRaw(uid, keepBody)).status, 201);
    assert.equal((await clarifyRaw(uid, first.proposal!, doctor, { optionId: doctor.clarification!.options[0]!.optionId }, { revision: 0 })).status, 200);
    const replay = await keepSeedRaw(uid, keepBody);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.replayed, true);
  } finally {
    endGate();
  }

  uid = beginGateRules();
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const spec = editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' });
    const edited = await gateEdit(uid, first.conversationId, spec);
    assert.equal((await keepSeedRaw(uid, { proposalId: first.proposal!.proposalId, seedItemId: travel.seedItemId, revision: revisionOf(edited.proposal) })).status, 201);
    const replay = await gateEditRaw(uid, first.conversationId, spec);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
  } finally {
    endGate();
  }
});

test('D1 a later chat rename cannot overwrite a locked structured words edit', async () => {
  const uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [modelItem('اتصل بأمي', TOMORROW, '17:00')] },
    { reply: 'الاسم محمي.', action: 'update', locked: [{ ref: 'i1', op: 'keep' }], open: [], added: [] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const renamed = await gateChat(uid, 'سميها اتصل بخالتي', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(renamed.proposal, call.itemId).title, 'اتصل بأختي', JSON.stringify(renamed.proposal));
  } finally {
    endGate();
  }
});

test('N3 acknowledgements and unrelated title words do not retire structured edits', async () => {
  let uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      locked: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '18:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, {
      time: { at: at(LATER, '20:00'), timeZone: ZONE },
    }));
    const next = await gateChat(uid, 'تمام، وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(next.proposal, call.itemId).resolvedTime, at(LATER, '20:00'));
  } finally {
    endGate();
  }

  uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت العنوان.', 'update', {
      locked: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('روح على عنوان الدكتور', TOMORROW, '18:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const next = await gateChat(uid, 'ماشي، وكمان لازم روح على عنوان الدكتور بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(next.proposal, call.itemId).title, 'اتصل بأختي');
  } finally {
    endGate();
  }
});

test('N4 a versioned clarification merges a seed keep committed after its read', async () => {
  const rig = begin('VersionedClarifyKeepRace');
  try {
    const first = await chat(rig.uid, 'Maybe I will travel this summer. Remind me to call Dana tomorrow');
    const seed = first.proposal.seeds[0]!;
    const item = first.proposal.items.find((candidate) => candidate.clarification)!;
    const keepBody = {
      proposalId: first.proposal.proposalId,
      seedItemId: seed.seedItemId,
      revision: first.proposal.revision,
    };
    rig.storage.arm(async () => {
      const keep = await raw(await seedsPost(request('/api/mobile/seeds', rig.uid, keepBody)));
      assert.equal(keep.status, 201, JSON.stringify(keep.body));
    });
    const clarified = await raw(await clarifyPost(request('/api/mobile/capture/clarify', rig.uid, {
      proposalId: first.proposal.proposalId,
      itemId: item.itemId,
      questionId: item.clarification!.questionId,
      optionId: item.clarification!.options[0]!.optionId,
      revision: first.proposal.revision,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    })));
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));

    const stored = await new StorageCaptureProposalStore(rig.storage).get(first.proposal.proposalId);
    assert.deepEqual(stored?.keptSeedItemIds, [seed.seedItemId]);
    assert.equal(stored?.seedKeepReceipt?.seedItemId, seed.seedItemId);
    const retry = await raw(await seedsPost(request('/api/mobile/seeds', rig.uid, keepBody)));
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.replayed, true);

    const edit = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid, {
      conversationId: first.conversationId,
      edit: {
        proposalId: first.proposal.proposalId,
        revision: clarified.body.revision,
        target: { seedItemId: seed.seedItemId },
        change: { kind: 'commitment', time: { at: at(LATER, '17:00'), timeZone: ZONE } },
      },
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
      locale: 'en',
    })));
    assert.equal(edit.status, 400, JSON.stringify(edit.body));
    assert.equal(edit.body.reason, 'edit_invalid');
  } finally {
    rig.end();
  }
});

test('R14 a seed in the visible model list remains a seed on the following message', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      locked: [{ ref: 's1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '18:00')],
    }),
    modelRefAnswer('حدّثت الخبز.', 'update', {
      locked: [{ ref: 's1', op: 'keep' }],
      open: [{ ref: 'i1', op: 'update', fields: modelItem('اشتري خبز', TOMORROW, '18:00') }],
    }),
  );
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    await gateEdit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'idea' }));
    await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.seeds.find((candidate) => candidate.seedItemId === travel.seedItemId)?.kind, 'idea', JSON.stringify(next.proposal));
    assert.ok(!next.proposal!.items.some((candidate) => candidate.title.includes('أسافر')), JSON.stringify(next.proposal));
  } finally {
    endGate();
  }
});

test('D8 a revisioned keep between a legacy clarify read and write ends the legacy chain', async () => {
  const rig = begin('LegacyClarifyKeepRace');
  try {
    const started = await raw(await chatPost(request('/api/mobile/capture/chat', rig.uid, {
      message: 'Maybe I will travel this summer. Remind me to call Dana tomorrow and email Sam on Friday',
      timezone: ZONE,
      referenceTime: '2026-10-07T07:00:00.000Z',
      locale: 'en',
    })));
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const first = started.body as Chat;
    assert.equal(first.proposal.items.filter((item) => item.clarification).length, 2, JSON.stringify(first.proposal));
    assert.equal(first.proposal.seeds.length, 1, JSON.stringify(first.proposal));
    const firstQuestion = first.proposal.items.find((item) => item.clarification)!;
    const clarified = await raw(await clarifyPost(request('/api/mobile/capture/clarify', rig.uid, {
      proposalId: first.proposal.proposalId,
      itemId: firstQuestion.itemId,
      questionId: firstQuestion.clarification!.questionId,
      optionId: firstQuestion.clarification!.options[0]!.optionId,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    })));
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
    const current = clarified.body as Proposal;
    const secondQuestion = current.items.find((item) => item.clarification)!;
    const seed = current.seeds[0]!;
    rig.storage.arm(async () => {
      const keep = await raw(await seedsPost(request('/api/mobile/seeds', rig.uid, {
        proposalId: current.proposalId,
        seedItemId: seed.seedItemId,
        revision: current.revision,
      })));
      assert.equal(keep.status, 201, JSON.stringify(keep.body));
    });
    const raced = await raw(await clarifyPost(request('/api/mobile/capture/clarify', rig.uid, {
      proposalId: current.proposalId,
      itemId: secondQuestion.itemId,
      questionId: secondQuestion.clarification!.questionId,
      optionId: secondQuestion.clarification!.options[0]!.optionId,
      timezone: ZONE,
      referenceTime: new Date().toISOString(),
    })));
    assert.equal(raced.status, 409, JSON.stringify(raced.body));
    assert.equal(raced.body.state, 'open');
    const legacyConfirm = await raw(await confirmPost(request('/api/mobile/capture/confirm', rig.uid, {
      proposalId: current.proposalId,
      itemIds: current.items.map((item) => item.itemId),
    })));
    assert.equal(legacyConfirm.status, 409, JSON.stringify(legacyConfirm.body));
  } finally {
    rig.end();
  }
});

test('N3e a remaining correction span survives carry-forward and can be rejected later', async () => {
  const uid = beginGateModel(modelFirstAnswer('راجع القائمة.', 'propose', [
    modelItem('اطلع عالسوق وجيب خبز', TOMORROW, '17:00', modelCorrections(['الطلع', 'اطلع'], ['خبس', 'خبز'])),
  ]));
  try {
    const first = await gateChat(uid, 'لازم الطلع عالسوق وجيب خبس بكرا الساعة 5 المسا', { locale: 'ar', spoken: true });
    const item = itemWith(first.proposal, 'عالسوق');
    const firstRejected = await gateEdit(uid, first.conversationId, editOf(first, { itemId: item.itemId }, {
      rejectCorrectionIds: [item.corrections![0]!.id],
    }));
    takeModelDown();
    const carried = await gateChat(uid, 'وكمان لازم اشتري حليب بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const carriedItem = itemById(carried.proposal, item.itemId);
    assert.equal(carriedItem.corrections?.length, 1, JSON.stringify(carriedItem));
    const secondRejected = await gateEditRaw(uid, first.conversationId, editOf(carried, { itemId: item.itemId }, {
      rejectCorrectionIds: [carriedItem.corrections![0]!.id],
    }));
    assert.equal(secondRejected.status, 200, JSON.stringify(secondRejected.body));
    assert.equal(itemById((secondRejected.body as Answer).proposal, item.itemId).title, 'الطلع عالسوق وجيب خبس');
    assert.equal(revisionOf(firstRejected.proposal), 1);
  } finally {
    endGate();
  }
});

test('ND1 a locked edited call removed by chat is restorable and cannot be relabelled as bread', async () => {
  const uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ] },
    { reply: 'شلت الاتصال وأضفت الخبز.', action: 'update', locked: [{ ref: 'i1', op: 'remove' }], open: [{ ref: 'i2', op: 'keep' }], added: [
      modelItem('اشتري خبز', TOMORROW, '19:00'),
    ] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const next = await gateChat(uid, 'شيل الاتصال، ولازم اشتري خبز بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.deepEqual(new Set(next.proposal!.items.map((item) => item.title)), new Set(['اشتري خبز', 'ادفع الفاتورة']));
    assert.deepEqual((next.proposal as GateProposal & Proposal).removedItems, [{ itemId: call.itemId, kind: 'commitment', text: 'اتصل بأختي' }]);
    const unknownRestore = await gateEditRaw(uid, first.conversationId, {
      proposalId: next.proposal!.proposalId,
      revision: revisionOf(next.proposal),
      target: { itemId: 'not-removed' },
      change: { restore: true },
    } as never);
    assertEditInvalid(unknownRestore, 'an unknown removed item cannot be restored');
    const mixedRestore = await gateEditRaw(uid, first.conversationId, {
      proposalId: next.proposal!.proposalId,
      revision: revisionOf(next.proposal),
      target: { itemId: call.itemId },
      change: { restore: true, text: 'not allowed' },
    } as never);
    assertEditInvalid(mixedRestore, 'restore is the only allowed change field');
    const restored = await gateEditRaw(uid, first.conversationId, {
      proposalId: next.proposal!.proposalId,
      revision: revisionOf(next.proposal),
      target: { itemId: call.itemId },
      change: { restore: true },
    } as never);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const restoredProposal = (restored.body as Answer).proposal as GateProposal & Proposal;
    assert.equal(itemById(restoredProposal, call.itemId).title, 'اتصل بأختي');
    assert.equal(restoredProposal.items[0]!.itemId, call.itemId, 'restore changed the original list position');
    assert.equal(restoredProposal.removedItems, undefined);
    assert.equal(revisionOf(restoredProposal), revisionOf(next.proposal) + 1);
  } finally {
    endGate();
  }
});

test('v9 ref schema uses only this turn refs, carries citations, and hostile ref parsing is content-free', () => {
  const schema = geminiChatSchemaFor(['i1', 's1'], ['i2']) as any;
  assert.deepEqual(schema.properties.locked.items.properties.ref.enum, ['i1', 's1']);
  const [keepSchema, removeSchema, updateSchema] = schema.properties.open.items.anyOf;
  assert.deepEqual(keepSchema.properties.ref.enum, ['i2']);
  assert.deepEqual(removeSchema.properties.ref.enum, ['i2']);
  assert.deepEqual(updateSchema.properties.ref.enum, ['i2']);
  assert.equal(updateSchema.properties.source.type, 'string');
  assert.deepEqual(updateSchema.required, ['ref', 'op', 'fields', 'source']);
  assert.equal(schema.properties.added.items.properties.source.type, 'string');
  assert.ok(schema.properties.added.items.required.includes('source'));
  const firstTurn = geminiChatSchemaFor([], []) as any;
  assert.equal(firstTurn.properties.added.items.required.includes('source'), false);

  const parsed = parseChatModelAnswer(JSON.stringify({
    reply: 'ok', action: 'update',
    locked: [{ ref: 'i1', op: 'update', fields: { title: 'overwrite' } }, { ref: 'i1', op: 'remove' }],
    open: [{ ref: 'i2', op: 'keep' }, { ref: 'i2', op: 'remove' }, { ref: 'invented', op: 'remove' }],
    added: [],
  }), { lockedRefs: new Set(['i1']), openRefs: new Set(['i2']) });
  assert.ok(parsed);
  assert.deepEqual(parsed!.locked, [{ ref: 'i1', op: 'remove' }]);
  assert.deepEqual(parsed!.open, [{ ref: 'i2', op: 'keep' }]);
  assert.equal(parsed!.ignoredRefOperations, 3);
  assert.equal(parseChatModelAnswer(JSON.stringify({ reply: 'ok', action: 'update', locked: [], open: [], added: [], extra: true }), {
    lockedRefs: new Set(), openRefs: new Set(),
  }), null, 'an unagreed top-level shape must not be partially applied');
});

test('a retired full-list answer never replaces the current ref-based list', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ]),
    { reply: 'استبدلت القائمة.', action: 'update', items: [modelItem('اشتري خبز', TOMORROW, '19:00')] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 وادفع الفاتورة الساعة 6 المسا', { locale: 'ar' });
    const next = await gateChat(uid, 'لازم اشتري خبز بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.deepEqual(next.proposal!.items.map((item) => item.itemId), first.proposal!.items.map((item) => item.itemId));
    assert.deepEqual(next.proposal!.items.map((item) => item.title), first.proposal!.items.map((item) => item.title));
    assert.equal(next.proposal!.items.some((item) => item.title.includes('خبز')), false);
  } finally {
    endGate();
  }
});

test('the carry path has no title, ordinal, raw-text, cancel, rename, or acknowledgement matcher', () => {
  const merge = readFileSync('lib/services/captureChat/refMerge.ts', 'utf8');
  const service = readFileSync('lib/services/captureChat/captureChatService.ts', 'utf8');
  const mobile = readFileSync('lib/services/mobile/mobileCaptureService.ts', 'utf8');
  const prompt = readFileSync('lib/services/captureChat/chatPrompt.ts', 'utf8');
  const boundary = readFileSync('lib/services/captureBoundary/captureBoundaryService.ts', 'utf8');
  const evidence = readFileSync('lib/services/captureBoundary/chatEvidence.ts', 'utf8');
  const mergeImports = Array.from(merge.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g), (match) => match[1]).sort();
  assert.deepEqual(mergeImports, [
    '../../../src/contracts/v1/captureContracts',
    '../captureBoundary/proposalStore',
    '../captureBoundary/understood',
    './chatReferences',
  ].sort(), 'the identity-only merge imported a new dependency; review it before allowing text matching');
  assert.doesNotMatch(merge, /(?:\.|\[['"])(?:title|summary|text)(?:\b|['"]\])/,
    'the identity-only merge must not inspect user-facing words inline');
  assert.doesNotMatch(merge, /\b(?:const|let|var)\s*\{[^}]*\b(?:title|summary|text)\b/,
    'the identity-only merge must not inspect user-facing words by destructuring');
  assert.doesNotMatch(mobile, /carryStructuredEditsForward|ordinalMatch|rawMatches/);
  assert.doesNotMatch(boundary, /withPreviousTitles/);
  assert.doesNotMatch(evidence, /renamesListItem|cancelsListItem|const RENAME/);
  assert.doesNotMatch(service, /legacyTestAnswer|legacyItems|legacyRefs/,
    'production must not accept or reconstruct the retired full-list model answer');
  assert.match(prompt, /only identifies an existing entry by position/);
  assert.match(prompt, /Never use those referring words as an item title/);
});

test('v5 reorder, omission, invented and duplicate refs use identity; remove plus add may keep the same length', async () => {
  const uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
      modelItem('روح عالنادي', TOMORROW, '19:00'),
    ] },
    { reply: 'حدّثت القائمة.', action: 'update', locked: [], open: [
      { ref: 'i3', op: 'keep' },
      { ref: 'invented', op: 'remove' },
      { ref: 'i2', op: 'remove' },
      { ref: 'i2', op: 'update', fields: modelItem('شيء مخترع', TOMORROW, '20:00') },
    ], added: [modelItem('اشتري خبز', TOMORROW, '20:00')] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي الساعة 5 وادفع الفاتورة الساعة 6 واروح عالنادي الساعة 7 بكرا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const next = await gateChat(uid, 'شيل الفاتورة وكمان لازم اشتري خبز بكرا الساعة 8 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.items.length, 3);
    assert.equal(itemById(next.proposal, call.itemId).title, 'اتصل بأمي', 'an omitted ref is kept with the same id');
    assert.deepEqual(new Set(next.proposal!.items.map((item) => item.title)), new Set(['اتصل بأمي', 'روح عالنادي', 'اشتري خبز']));
  } finally {
    endGate();
  }
});

test('ND2 rules fallback never rebuilds or chat-renames; it appends only genuinely new requests', async () => {
  const uid = beginGateModel({ reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [
    modelItem('اتصل بأمي', TOMORROW, '17:00'),
  ] });
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const edited = await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    takeModelDown();
    const refused = await gateChat(uid, 'غيّر اسمها لاتصل بخالتي وشيلها', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(refused.proposal, call.itemId).title, 'اتصل بأختي');
    assert.equal(revisionOf(refused.proposal), revisionOf(edited.proposal));
    const appended = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(appended.proposal, call.itemId).title, 'اتصل بأختي');
    assert.ok(appended.proposal!.items.some((item) => item.title.includes('اشتري خبز')));
  } finally {
    endGate();
  }
});

test('a retried message receipt ignores a fresh referenceTime for 120 seconds, then treats the message as new', async () => {
  const uid = beginGateModel(
    { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [modelItem('اتصل بأمي', TOMORROW, '17:00')] },
    { reply: 'أضفت الخبز.', action: 'update', locked: [], open: [{ ref: 'i1', op: 'keep' }], added: [modelItem('اشتري خبز', TOMORROW, '18:00')] },
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const once = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', {
      conversationId: first.conversationId, locale: 'ar', referenceTime: REFERENCE,
    });
    const retry = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', {
      conversationId: first.conversationId, locale: 'ar', referenceTime: new Date(Date.parse(REFERENCE) + 1_000).toISOString(),
    });
    assert.deepEqual(retry, once);
    assert.equal(retry.proposal!.items.filter((item) => item.title.includes('خبز')).length, 1);
    assert.equal(modelCalls(), 2, 'the retry called the model again');
    const conversationPath = captureConversationPath(uid, first.conversationId);
    const storedConversation = await currentStorage().get<Record<string, any>>(conversationPath);
    assert.ok(storedConversation?.messageReceipt?.receivedAt);
    storedConversation!.messageReceipt.receivedAt -= 121_000;
    await currentStorage().set(conversationPath, storedConversation!);
    const afterWindow = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', {
      conversationId: first.conversationId, locale: 'ar', referenceTime: new Date(Date.parse(REFERENCE) + 122_000).toISOString(),
    });
    assert.equal(modelCalls(), 3, 'a message after the receipt window replayed the old answer');
    assert.equal(afterWindow.proposal!.items.filter((item) => item.title.includes('خبز')).length, 2);
  } finally {
    endGate();
  }
});

test('a retry receipt overlays the current revision after a clarification and never calls the model again', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('أي ساعة؟', 'ask', [
      modelItem('اتصل بأمي', TOMORROW, null), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }, { ref: 'i2', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' });
    const message = 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا';
    const beforeClarify = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    const call = itemWith(beforeClarify.proposal, 'اتصل بأمي');
    const clarified = await clarifyRaw(uid, beforeClarify.proposal!, call, { freeText: 'الساعة 9 الصبح' });
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
    const retry = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(modelCalls(), 2, 'the retry called the model after a clarification');
    assert.notEqual(retry.reply, beforeClarify.reply, 'the retry kept the stale pre-clarification question');
    assert.doesNotMatch(retry.reply, /أي ساعة/, 'the live settled list was described as still asking');
    assert.equal(itemById(retry.proposal, call.itemId).resolvedTime, at(TOMORROW, '09:00'));
    assert.equal(revisionOf(retry.proposal), revisionOf(clarified.body));
    assert.equal(retry.proposal!.items.filter((item) => item.title.includes('خبز')).length, 1);
  } finally {
    endGate();
  }
});

test('a retry receipt notices a revision change even when clarification leaves the lock set unchanged', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('أي ساعة؟', 'ask', [
      modelItem('اتصل بأمي', TOMORROW, null), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      locked: [{ ref: 'i1', op: 'keep' }],
      open: [{ ref: 'i2', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا وادفع الفاتورة بكرا الساعة 6 المسا', { locale: 'ar' });
    const originalCall = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: originalCall.itemId }, { text: 'اتصل بماما' }), { locale: 'ar' });
    const message = 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا';
    const beforeClarify = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    const call = itemById(beforeClarify.proposal, originalCall.itemId);
    assert.ok(call.clarification, JSON.stringify(call));
    const clarified = await clarifyRaw(uid, beforeClarify.proposal!, call, { freeText: 'الساعة 9 الصبح' });
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
    assert.equal(revisionOf(beforeClarify.proposal) + 1, revisionOf(clarified.body));
    const retry = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(modelCalls(), 2, 'the retry called the model when only the revision changed');
    assert.notEqual(retry.reply, beforeClarify.reply, 'the retry kept the stale pre-clarification question');
    assert.doesNotMatch(retry.reply, /أي ساعة/, 'the live settled list was described as still asking');
    assert.equal(revisionOf(retry.proposal), revisionOf(clarified.body));
    assert.equal(itemById(retry.proposal, call.itemId).resolvedTime, at(TOMORROW, '09:00'));
  } finally {
    endGate();
  }
});

test('a retry receipt overlays the current lock set after keeping a seed and never calls the model again', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }, { ref: 's1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const message = 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا';
    const beforeKeep = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    const travel = seedWith(beforeKeep.proposal, 'أسافر');
    assert.equal((await keepSeedRaw(uid, {
      proposalId: beforeKeep.proposal!.proposalId,
      seedItemId: travel.seedItemId,
      revision: revisionOf(beforeKeep.proposal),
    })).status, 201);
    const retry = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(modelCalls(), 2, 'the retry called the model after a keep');
    assert.notEqual(retry.reply, beforeKeep.reply, 'the retry kept the stale pre-keep edit acknowledgement');
    assert.equal(seedWith(retry.proposal, 'أسافر').seedItemId, travel.seedItemId);
    assert.equal(retry.proposal!.items.filter((item) => item.title.includes('خبز')).length, 1);
  } finally {
    endGate();
  }
});

test('a retry receipt overlays a confirmed proposal and never calls the model again', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const message = 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا';
    const beforeConfirm = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    const confirmed = await confirmRaw(uid, {
      proposalId: beforeConfirm.proposal!.proposalId,
      revision: revisionOf(beforeConfirm.proposal),
      itemIds: beforeConfirm.proposal!.items.map((item) => item.itemId),
      idempotencyKey: 'retry-after-confirm',
    });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    const savedBeforeRetry = await savedCommitments(uid);
    const retry = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(modelCalls(), 2, 'the retry called the model after confirm');
    assert.notEqual(retry.reply, beforeConfirm.reply, 'the retry kept a reply describing a list that was already confirmed');
    assert.match(retry.reply, /already saved|انحفظت|حفظنا/i);
    assert.equal(retry.proposal, null);
    assert.deepEqual(await savedCommitments(uid), savedBeforeRetry, 'the retry persisted the points twice');
  } finally {
    endGate();
  }
});

test('spoken and locale are both part of the retry fingerprint', async () => {
  let uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت السوق.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('اطلع عالسوق', TOMORROW, '19:00')],
    }),
    modelRefAnswer('صححت السوق.', 'update', {
      open: [
        { ref: 'i1', op: 'keep' },
        { ref: 'i2', op: 'update', fields: modelItem('اطلع عالسوق', TOMORROW, '19:00', modelCorrections(['الطلع', 'اطلع'])) },
      ],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const message = 'وكمان لازم الطلع عالسوق بكرا الساعة 7 المسا';
    await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    const spoken = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar', spoken: true });
    assert.equal(modelCalls(), 3, 'typed input was replayed for a spoken message');
    assert.deepEqual(itemWith(spoken.proposal, 'عالسوق').corrections?.map(({ from, to }) => ({ from, to })), [
      { from: 'الطلع', to: 'اطلع' },
    ]);
  } finally {
    endGate();
  }

  uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }], added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
    modelRefAnswer('Confirm below.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }, { ref: 'i2', op: 'keep' }],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const message = 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا';
    await gateChat(uid, message, { conversationId: first.conversationId, locale: 'ar' });
    await gateChat(uid, message, { conversationId: first.conversationId, locale: 'en' });
    assert.equal(modelCalls(), 3, 'the old locale answer was replayed after the app language changed');
  } finally {
    endGate();
  }
});

for (const [label, locale, firstMessage, firstItem, message, added, expectedTitle] of [
  ['Arabic', 'ar', 'لازم اتصل بأمي بكرا الساعة 5 المسا', modelItem('اتصل بأمي', TOMORROW, '17:00'), 'وكمان لازم اشتري خبز', modelItem('اشتري خبز', null, null), 'اشتري خبز'],
  ['English', 'en', 'I need to call mom tomorrow at 5 PM', modelItem('Call mom', TOMORROW, '17:00'), 'I also need to buy bread', modelItem('Buy bread', null, null), 'Buy bread'],
] as const) test(`a later untimed commitment uses only its own ${label} words`, async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [firstItem]),
    modelRefAnswer('When?', 'ask', { open: [{ ref: 'i1', op: 'keep' }], added: [added] }),
  );
  try {
    const first = await gateChat(uid, firstMessage, { locale });
    const next = await gateChat(uid, message, { conversationId: first.conversationId, locale });
    const bread = itemWith(next.proposal, expectedTitle);
    assert.equal(bread.resolvedTime, null, JSON.stringify(bread));
    assert.equal(bread.needsClarification, true, JSON.stringify(bread));
    assert.deepEqual(bread.conflicts ?? [], []);
  } finally {
    endGate();
  }
});

for (const [label, locale, message, item, word, kind] of [
  ['Arabic consideration', 'ar', 'عم بفكر أسافر الصيف الجاي', modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }), 'أسافر', 'consideration'],
  ['English consideration', 'en', "I'm thinking about traveling next summer", modelItem('Travel next summer', null, null, { kind: 'consideration' }), 'travel', 'consideration'],
  ['English idea', 'en', 'maybe learn the oud', modelItem('Learn the oud', null, null, { kind: 'idea' }), 'oud', 'idea'],
] as const) test(`a later ${label} stays a seed`, async () => {
  const firstMessage = locale === 'ar' ? 'لازم اتصل بأمي بكرا الساعة 5 المسا' : 'I need to call mom tomorrow at 5 PM';
  const call = locale === 'ar' ? modelItem('اتصل بأمي', TOMORROW, '17:00') : modelItem('Call mom', TOMORROW, '17:00');
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [call]),
    modelRefAnswer('Review it.', 'update', { open: [{ ref: 'i1', op: 'keep' }], added: [item] }),
  );
  try {
    const first = await gateChat(uid, firstMessage, { locale });
    const next = await gateChat(uid, message, { conversationId: first.conversationId, locale });
    assert.equal(next.proposal!.seeds.length, 1, JSON.stringify(next.proposal));
    assert.equal(next.proposal!.seeds[0]!.kind, kind);
    assert.match(next.proposal!.seeds[0]!.summary.toLowerCase(), new RegExp(word.toLowerCase()));
    assert.equal(next.proposal!.items.length, 1, JSON.stringify(next.proposal));
  } finally {
    endGate();
  }
});

test('a later thought keeps its words after an untimed first item, while a later item with its own time keeps that time', async () => {
  let uid = beginGateModel(
    modelFirstAnswer('أي ساعة؟', 'ask', [modelItem('اتصل بأمي', null, null)]),
    modelRefAnswer('راجع.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي', { locale: 'ar' });
    const next = await gateChat(uid, 'وعم بفكر أسافر الصيف الجاي', { conversationId: first.conversationId, locale: 'ar' });
    assert.match(next.proposal!.seeds[0]!.summary, /أسافر/);
    assert.doesNotMatch(next.proposal!.seeds[0]!.summary, /اتصل/);
  } finally {
    endGate();
  }

  uid = beginGateModel(
    modelFirstAnswer('راجع.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('راجع.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }], added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemWith(next.proposal, 'اشتري خبز').resolvedTime, at(TOMORROW, '19:00'));
  } finally {
    endGate();
  }
});

test('an open update cannot take a changed time from an older turn', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Changed.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('Call mom', TOMORROW, '18:00') }],
    }),
    modelRefAnswer('Renamed.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('Phone mom', TOMORROW, '17:00') }],
    }),
  );
  try {
    const first = await gateChat(uid, 'I need to call mom tomorrow at 5 PM', { locale: 'en' });
    const moved = await gateChat(uid, 'make it 6 PM', { conversationId: first.conversationId, locale: 'en' });
    const renamed = await gateChat(uid, 'rename it to Phone mom', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(itemWith(moved.proposal, 'Call mom').resolvedTime, at(TOMORROW, '18:00'));
    const item = itemWith(renamed.proposal, 'Phone mom');
    assert.equal(item.resolvedTime, at(TOMORROW, '18:00'), JSON.stringify(item));
    assert.equal(item.needsClarification, false, JSON.stringify(item));
  } finally {
    endGate();
  }
});

for (const scenario of [
  {
    label: 'Arabic consideration', locale: 'ar' as const,
    firstMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا',
    first: modelItem('اتصل بأمي', TOMORROW, '17:00'),
    thoughtMessage: 'وعم بفكر أسافر الصيف الجاي',
    thought: modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    refineMessage: 'يمكن بالطيارة',
    refined: modelItem('أسافر الصيف الجاي بالطيارة', null, null, { kind: 'consideration' }),
    word: 'بالطيارة', kind: 'consideration',
  },
  {
    label: 'English consideration', locale: 'en' as const,
    firstMessage: 'I need to call mom tomorrow at 5 PM',
    first: modelItem('Call mom', TOMORROW, '17:00'),
    thoughtMessage: "I'm thinking about traveling next summer",
    thought: modelItem('Travel next summer', null, null, { kind: 'consideration' }),
    refineMessage: 'maybe by plane',
    refined: modelItem('Travel next summer by plane', null, null, { kind: 'consideration' }),
    word: 'plane', kind: 'consideration',
  },
  {
    label: 'English idea', locale: 'en' as const,
    firstMessage: 'I need to call mom tomorrow at 5 PM',
    first: modelItem('Call mom', TOMORROW, '17:00'),
    thoughtMessage: 'idea: a cooking podcast',
    thought: modelItem('Cooking podcast', null, null, { kind: 'idea' }),
    refineMessage: 'with my sister as co-host',
    refined: modelItem('Cooking podcast with my sister', null, null, { kind: 'idea' }),
    word: 'sister', kind: 'idea',
  },
] as const) test(`an updated ${scenario.label} is rebuilt only from its ref and prior version`, async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [scenario.first]),
    modelRefAnswer('Review it.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }], added: [scenario.thought],
    }),
    modelRefAnswer('Updated.', 'update', {
      open: [
        { ref: 'i1', op: 'keep' },
        { ref: 's1', op: 'update', fields: scenario.refined },
      ],
    }),
  );
  try {
    const first = await gateChat(uid, scenario.firstMessage, { locale: scenario.locale });
    await gateChat(uid, scenario.thoughtMessage, { conversationId: first.conversationId, locale: scenario.locale });
    const refined = await gateChat(uid, scenario.refineMessage, { conversationId: first.conversationId, locale: scenario.locale });
    assert.equal(refined.proposal!.items.length, 1, JSON.stringify(refined.proposal));
    assert.equal(refined.proposal!.seeds.length, 1, JSON.stringify(refined.proposal));
    assert.equal(refined.proposal!.seeds[0]!.kind, scenario.kind);
    assert.match(refined.proposal!.seeds[0]!.summary.toLowerCase(), new RegExp(scenario.word.toLowerCase()));
    assert.deepEqual(refined.proposal!.items[0]!.conflicts ?? [], []);
  } finally {
    endGate();
  }
});

test('a thought from the first mixed message stays a thought when its ref is updated', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelRefAnswer('حدّثت الفكرة.', 'update', {
      open: [
        { ref: 'i1', op: 'keep' },
        { ref: 's1', op: 'update', fields: modelItem('أسافر الصيف الجاي بالطيارة', null, null, { kind: 'consideration' }) },
      ],
    }),
  );
  try {
    const first = await gateChat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const next = await gateChat(uid, 'يمكن بالطيارة', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.seeds.length, 1, JSON.stringify(next.proposal));
    assert.equal(next.proposal!.seeds[0]!.kind, 'consideration');
    assert.match(next.proposal!.seeds[0]!.summary, /بالطيارة/);
    assert.equal(next.proposal!.items.length, 1);
    assert.deepEqual(next.proposal!.items[0]!.conflicts ?? [], []);
  } finally {
    endGate();
  }
});

test('an updated thought keeps its own words when the earlier commitment had no time', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('أي ساعة؟', 'ask', [modelItem('اتصل بأمي', null, null)]),
    modelRefAnswer('راجع.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })],
    }),
    modelRefAnswer('حدّثت الفكرة.', 'update', {
      open: [
        { ref: 'i1', op: 'keep' },
        { ref: 's1', op: 'update', fields: modelItem('أسافر الصيف الجاي بالطيارة', null, null, { kind: 'consideration' }) },
      ],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي', { locale: 'ar' });
    await gateChat(uid, 'وعم بفكر أسافر الصيف الجاي', { conversationId: first.conversationId, locale: 'ar' });
    const next = await gateChat(uid, 'يمكن بالطيارة', { conversationId: first.conversationId, locale: 'ar' });
    assert.match(next.proposal!.seeds[0]!.summary, /أسافر/);
    assert.doesNotMatch(next.proposal!.seeds[0]!.summary, /اتصل/);
  } finally {
    endGate();
  }
});

for (const scenario of [
  {
    label: 'Arabic', locale: 'ar' as const,
    callMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا', call: modelItem('اتصل بأمي', TOMORROW, '17:00'),
    breadMessage: 'وكمان لازم اشتري خبز', bread: modelItem('اشتري خبز', null, null),
    changeMessage: 'لا مش خبز، كعك، وكمان لازم ادرس', cake: modelItem('كعك', null, null), study: modelItem('ادرس', null, null),
    cakeTitle: 'كعك', studyTitle: 'ادرس',
  },
  {
    label: 'English', locale: 'en' as const,
    callMessage: 'I need to call mom tomorrow at 5 PM', call: modelItem('Call mom', TOMORROW, '17:00'),
    breadMessage: 'I also need to buy bread', bread: modelItem('Buy bread', null, null),
    changeMessage: 'not bread, cake. And I need to study', cake: modelItem('Cake', null, null), study: modelItem('Study', null, null),
    cakeTitle: 'Cake', studyTitle: 'Study',
  },
] as const) test(`a mixed rename and add uses refs rather than ${scenario.label} title matching`, async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [scenario.call]),
    modelRefAnswer('When?', 'ask', { open: [{ ref: 'i1', op: 'keep' }], added: [scenario.bread] }),
    modelRefAnswer('Updated.', 'update', {
      open: [
        { ref: 'i1', op: 'keep' },
        { ref: 'i2', op: 'update', fields: scenario.cake, source: scenario.locale === 'ar' ? 'لا مش خبز، كعك' : 'not bread, cake' } as any,
      ],
      added: [{ ...scenario.study, source: scenario.locale === 'ar' ? 'وكمان لازم ادرس' : 'And I need to study' }],
    }),
  );
  try {
    const first = await gateChat(uid, scenario.callMessage, { locale: scenario.locale });
    await gateChat(uid, scenario.breadMessage, { conversationId: first.conversationId, locale: scenario.locale });
    const next = await gateChat(uid, scenario.changeMessage, { conversationId: first.conversationId, locale: scenario.locale });
    const cake = itemWith(next.proposal, scenario.cakeTitle);
    assert.equal(cake.resolvedTime, null, JSON.stringify(cake));
    assert.equal(cake.needsClarification, true, JSON.stringify(cake));
    assert.deepEqual(cake.conflicts ?? [], []);
    assert.ok(next.proposal!.items.some((item) => item.title.includes(scenario.studyTitle)), JSON.stringify(next.proposal));
  } finally {
    endGate();
  }
});

test('an unchanged update needs no citation, preserves the exact item, and forces a truthful reply', async () => {
  const unchanged = modelItem('اشتري خبز', null, null, {
    priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
  });
  const uid = beginGateModel(
    modelFirstAnswer('إيمتى؟', 'ask', [unchanged]),
    modelRefAnswer('غيّرت الخبز وأضفت الدراسة.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: unchanged, source: 'لازم اشتري خبز' } as any],
      added: [{ ...modelItem('ادرس', null, null), source: 'ولازم ادرس كمان' }],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اشتري خبز', { locale: 'ar' });
    const before = structuredClone(first.proposal!.items[0]!);
    const next = await gateChat(uid, 'ولازم ادرس كمان', { conversationId: first.conversationId, locale: 'ar' });
    assert.deepEqual(next.proposal!.items[0], before);
    assert.ok(next.proposal!.items.some((item) => /[اأ]درس/.test(item.title)), JSON.stringify(next.proposal));
    assert.doesNotMatch(next.reply, /غيّرت الخبز/);
  } finally {
    endGate();
  }
});

for (const scenario of [
  {
    label: 'unnamed English', locale: 'en' as const, message: "I'm thinking about traveling next summer",
    thought: modelItem('Vacation abroad', null, null, { kind: 'consideration' }), kind: 'consideration',
  },
  {
    label: 'cross-language', locale: 'ar' as const, message: "I'm thinking about traveling next summer",
    thought: modelItem('Vacation abroad', null, null, { appTitle: 'عطلة بالخارج', kind: 'consideration' }), kind: 'consideration',
  },
] as const) test(`a later ${scenario.label} title need not occur in the person's words to stay a thought`, async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Review it.', 'update', { open: [{ ref: 'i1', op: 'keep' }], added: [scenario.thought] }),
  );
  try {
    const first = await gateChat(uid, 'I need to call mom tomorrow at 5 PM', { locale: scenario.locale });
    const next = await gateChat(uid, scenario.message, { conversationId: first.conversationId, locale: scenario.locale });
    assert.equal(next.proposal!.seeds.length, 1, JSON.stringify(next.proposal));
    assert.equal(next.proposal!.seeds[0]!.kind, scenario.kind);
    assert.equal(next.proposal!.items.length, 1, JSON.stringify(next.proposal));
  } finally {
    endGate();
  }
});

test('a time stated before its item is not reused under the newest-message rule', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('What is that for?', 'ask', []),
    modelRefAnswer('When?', 'ask', { added: [modelItem('Call mom', null, null)] }),
  );
  try {
    const first = await gateChat(uid, 'Tomorrow at 5 PM', { locale: 'en' });
    const next = await gateChat(uid, 'I need to call mom', { conversationId: first.conversationId, locale: 'en' });
    const call = itemWith(next.proposal, 'Call mom');
    assert.equal(call.resolvedTime, null);
    assert.equal(call.needsClarification, true);
  } finally {
    endGate();
  }
});

test('spoken corrections follow their added or updated ref and never attach to a locked card', async () => {
  let uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اطلع عالسوق', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت البنك.', 'update', {
      locked: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('اطلع عالبنك', TOMORROW, '18:00', modelCorrections(['الطلع', 'اطلع']))],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اطلع عالسوق بكرا الساعة 5 المسا', { locale: 'ar' });
    const market = first.proposal!.items[0]!;
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: market.itemId }, {
      time: { at: at(LATER, '20:00'), timeZone: ZONE },
    }));
    const next = await gateChat(uid, 'وكمان لازم الطلع عالبنك بكرا الساعة 6 المسا', {
      conversationId: first.conversationId, locale: 'ar', spoken: true,
    });
    const lockedMarket = itemById(next.proposal, market.itemId);
    const bank = itemWith(next.proposal, 'عالبنك');
    assert.deepEqual(lockedMarket.corrections ?? [], [], 'the added item correction landed on the locked item');
    assert.deepEqual(bank.corrections?.map(({ from, to }) => ({ from, to })), [{ from: 'الطلع', to: 'اطلع' }]);
    const rejected = await gateEdit(uid, next.conversationId, editOf(next, { itemId: bank.itemId }, {
      rejectCorrectionIds: [bank.corrections![0]!.id],
    }));
    assert.equal(itemById(rejected.proposal, market.itemId).title, 'اطلع عالسوق');
    assert.equal(itemById(rejected.proposal, bank.itemId).title, 'الطلع عالبنك');
  } finally {
    endGate();
  }

  uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('روح عالبنك', TOMORROW, '17:00')]),
    modelRefAnswer('صححت البنك.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('اطلع عالبنك', TOMORROW, '17:00', modelCorrections(['الطلع', 'اطلع'])) }],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم روح عالبنك بكرا الساعة 5 المسا', { locale: 'ar' });
    const beforeId = first.proposal!.items[0]!.itemId;
    const updated = await gateChat(uid, 'لا، لازم الطلع عالبنك بكرا الساعة 5 المسا', {
      conversationId: first.conversationId, locale: 'ar', spoken: true,
    });
    const bank = itemById(updated.proposal, beforeId);
    assert.deepEqual(bank.corrections?.map(({ from, to }) => ({ from, to })), [{ from: 'الطلع', to: 'اطلع' }]);
  } finally {
    endGate();
  }
});

test('a correction follows its operation index when an earlier recurring add fans out', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Updated.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [
        { ...modelItem('Go to the gym', '2026-10-13', '19:00'), source: 'Also the gym every Tuesday and Thursday at 7 PM' },
        { ...modelItem('Buy bread', TOMORROW, '20:00', modelCorrections(['By', 'Buy'])), source: 'and By bread tomorrow at 8 PM' },
      ],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
    const next = await gateChat(uid, 'Also the gym every Tuesday and Thursday at 7 PM, and By bread tomorrow at 8 PM', {
      conversationId: first.conversationId, locale: 'en', spoken: true,
    });
    assert.deepEqual(itemWith(next.proposal, 'Buy bread').corrections?.map(({ from, to }) => ({ from, to })), [
      { from: 'By', to: 'Buy' },
    ]);
    assert.ok(next.proposal!.items.filter((item) => item.title === 'Go to the gym').length >= 2, JSON.stringify(next.proposal));
  } finally {
    endGate();
  }
});

test('a lock survives another chat turn and a dropped locked update gets a server no-change reply', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      locked: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '18:00')],
    }),
    modelRefAnswer('تمام، غيّرتها.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('اتصل بأمي', TOMORROW, '21:00') }],
      added: [],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = first.proposal!.items[0]!;
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, {
      text: 'اتصل بأختي', time: { at: at(LATER, '20:00'), timeZone: ZONE },
    }));
    await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const attacked = await gateChat(uid, 'خلّي الاتصال الساعة 9', { conversationId: first.conversationId, locale: 'ar' });
    const kept = itemById(attacked.proposal, call.itemId);
    assert.equal(kept.title, 'اتصل بأختي');
    assert.equal(kept.resolvedTime, at(LATER, '20:00'));
    assert.notEqual(attacked.reply, 'تمام، غيّرتها.');
    assert.match(attacked.reply, /ما قدرت أطبّق/);
  } finally {
    endGate();
  }
});

test('a partly invalid model answer rolls back every ref operation and uses a no-change reply', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('تمام، غيّرتها.', 'update', {
      open: [{ ref: 'i2', op: 'remove' }],
      added: [{ title: '' }],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 وادفع الفاتورة الساعة 6 المسا', { locale: 'ar' });
    const next = await gateChat(uid, 'شيل الفاتورة وضيف إشي', { conversationId: first.conversationId, locale: 'ar' });
    assert.deepEqual(next.proposal!.items.map((item) => item.itemId), first.proposal!.items.map((item) => item.itemId));
    assert.match(next.reply, /ما قدرت أطبّق/);
  } finally {
    endGate();
  }
});

test('an invalid update beside a two-day recurring add rolls back by operation index', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review.', 'propose', [
      modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('Done.', 'update', {
      open: [
        { ref: 'i1', op: 'update', fields: { title: 'broken' }, source: 'Call mom' } as any,
        { ref: 'i2', op: 'keep' },
      ],
      added: [{ ...modelItem('Go to the gym', '2026-10-13', '19:00'), source: 'go to the gym every Tuesday and Thursday at 7 PM' }],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', { locale: 'en' });
    const call = itemWith(first.proposal, 'Call mom');
    const next = await gateChat(uid, 'Also go to the gym every Tuesday and Thursday at 7 PM', {
      conversationId: first.conversationId, locale: 'en',
    });
    assert.deepEqual(next.proposal!.items.map((item) => item.itemId), first.proposal!.items.map((item) => item.itemId));
    assert.equal(itemById(next.proposal, call.itemId).title, 'Call mom');
    assert.equal(next.proposal!.items.some((item) => item.title === 'Go to the gym'), false);
    assert.match(next.reply, /couldn.t apply|could not apply/i);
  } finally {
    endGate();
  }
});

/* Exact mutation probes from the r11 independent verification (C4…O5). */

const citedUpdate = (ref: string, fields: Record<string, unknown>, source: string) => (
  { ref, op: 'update', fields, source } as any
);
const citedAdd = (fields: Record<string, unknown>, source: string) => ({ ...fields, source });

async function mutationTwoTurn(options: {
  label: string;
  firstMessage?: string;
  firstItems?: Record<string, unknown>[];
  message: string;
  operations: { open?: any[]; added?: unknown[] };
  locale?: 'ar' | 'en';
  reply?: string;
}): Promise<{ first: Answer; next: Answer }> {
  const firstMessage = options.firstMessage ?? 'Call mom tomorrow at 5 PM';
  const firstItems = options.firstItems ?? [modelItem('Call mom', TOMORROW, '17:00')];
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', firstItems),
    modelRefAnswer(options.reply ?? 'Done.', 'update', options.operations),
  );
  try {
    const first = await gateChat(uid, firstMessage, { locale: options.locale ?? 'en' });
    const next = await gateChat(uid, options.message, {
      conversationId: first.conversationId,
      locale: options.locale ?? 'en',
    });
    return { first, next };
  } finally {
    endGate();
  }
}

test('C4 citation boundaries allow one Arabic proclitic, never a mid-word English match', async () => {
  const arabic = await mutationTwoTurn({
    label: 'C4-dropwaw',
    firstMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا',
    firstItems: [modelItem('اتصل بأمي', TOMORROW, '17:00')],
    message: 'خلّي الاتصال الساعة 8 المسا، ولازم اشتري خبز',
    operations: {
      open: [citedUpdate('i1', modelItem('اتصل بأمي', TOMORROW, '20:00'), 'خلّي الاتصال الساعة 8 المسا')],
      added: [citedAdd(modelItem('اشتري خبز', null, null), 'لازم اشتري خبز')],
    },
    locale: 'ar',
  });
  assert.equal(itemWith(arabic.next.proposal, 'اتصل بأمي').resolvedTime, at(TOMORROW, '20:00'));
  assert.equal(itemWith(arabic.next.proposal, 'اشتري خبز').needsClarification, true);

  const midword = await mutationTwoTurn({
    label: 'C4-midword',
    message: 'Move the call to 8 PM. Also buy breadsticks.',
    operations: {
      open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00'), 'Move the call to 8 PM.')],
      added: [citedAdd(modelItem('Buy bread', null, null), 'bread')],
    },
  });
  assert.deepEqual(midword.next.proposal!.items.map((item) => item.itemId), midword.first.proposal!.items.map((item) => item.itemId));
  assert.equal(itemWith(midword.next.proposal, 'Call mom').resolvedTime, at(TOMORROW, '17:00'));
  assert.match(midword.next.reply, /couldn.t apply|could not apply/i);
});

test('C5 citation folding keeps Arabic shadda and alef variants equivalent', async () => {
  for (const [label, message, source] of [
    ['shadda', 'خلّي الاتصال الساعة 8 المسا', 'خلي الاتصال الساعة 8 المسا'],
    ['alef', 'أجّل الاتصال لبكرا الساعة 8 المسا', 'اجل الاتصال لبكرا الساعة 8 المسا'],
  ] as const) {
    const { next } = await mutationTwoTurn({
      label: `C5-${label}`,
      firstMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا',
      firstItems: [modelItem('اتصل بأمي', TOMORROW, '17:00')],
      message,
      operations: { open: [citedUpdate('i1', modelItem('اتصل بأمي', TOMORROW, '20:00'), source)] },
      locale: 'ar',
    });
    assert.equal(itemWith(next.proposal, 'اتصل بأمي').resolvedTime, at(TOMORROW, '20:00'), label);
  }
});

test('C7 a bad remove citation rolls the whole answer back', async () => {
  const { first, next } = await mutationTwoTurn({
    label: 'C7',
    message: 'Forget the call. I need to buy bread.',
    operations: {
      open: [{ ref: 'i1', op: 'remove', source: 'Forget the dentist.' } as any],
      added: [citedAdd(modelItem('Buy bread', null, null), 'I need to buy bread.')],
    },
  });
  assert.deepEqual(next.proposal!.items.map((item) => item.itemId), first.proposal!.items.map((item) => item.itemId));
  assert.equal(next.proposal!.items.some((item) => item.title === 'Buy bread'), false);
});

test('C8 a cited keep is ignored and cannot preserve the model success claim', async () => {
  const { next } = await mutationTwoTurn({
    label: 'C8',
    message: 'thanks',
    operations: { open: [{ ref: 'i1', op: 'keep', source: 'thanks' } as any] },
  });
  assert.equal(itemWith(next.proposal, 'Call mom').resolvedTime, at(TOMORROW, '17:00'));
  assert.doesNotMatch(next.reply, /^Done\.?$/i);
});

test('C19 a time-only citation cannot move the stored day', async () => {
  const { next } = await mutationTwoTurn({
    label: 'C19',
    message: 'make it 8 PM',
    operations: { open: [citedUpdate('i1', modelItem('Call mom', '2026-10-09', '20:00'), 'make it 8 PM')] },
  });
  assert.equal(itemWith(next.proposal, 'Call mom').resolvedTime, at(TOMORROW, '20:00'));
});

test('C20 priority is applied only to the point whose citation states it', async () => {
  const { next } = await mutationTwoTurn({
    label: 'C20',
    firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM',
    firstItems: [modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00')],
    message: 'The bill is urgent, and make the call 8 PM',
    operations: { open: [
      citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00', { priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false } }), 'make the call 8 PM'),
      citedUpdate('i2', modelItem('Pay the bill', TOMORROW, '18:00', { priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false } }), 'The bill is urgent'),
    ] },
  });
  assert.equal((itemWith(next.proposal, 'Call mom') as any).priority, 'normal');
  assert.equal((itemWith(next.proposal, 'Pay the bill') as any).priority, 'high');
});

test('C23 a kind change without matching newest intent is rejected', async () => {
  const drift = await mutationTwoTurn({
    label: 'C23',
    message: 'actually I am not sure',
    operations: { open: [citedUpdate('i1', modelItem('Call mom', null, null, { kind: 'consideration' }), 'actually I am not sure')] },
  });
  assert.equal(drift.next.proposal!.seeds.length, 0);
  assert.ok(drift.next.proposal!.items.some((item) => item.title === 'Call mom'));
});

test('F11 a commitment demoted to a thought preserves the point words', async () => {
  const demotion = await mutationTwoTurn({
    label: 'F11',
    firstMessage: 'Call mom',
    firstItems: [modelItem('Call mom', null, null)],
    message: "I'm thinking about calling mom",
    operations: { open: [citedUpdate('i1', modelItem('Call mom', null, null, { kind: 'consideration' }), "I'm thinking about calling mom")] },
  });
  assert.equal(demotion.next.proposal!.items.length, 0);
  assert.equal(demotion.next.proposal!.seeds[0]!.kind, 'consideration');
  assert.match(demotion.next.proposal!.seeds[0]!.summary, /Call mom/i);
});

test('C24 the time valve reads only each operation citation', async () => {
  const update = await mutationTwoTurn({
    label: 'C24-update',
    firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM',
    firstItems: [modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00')],
    message: 'Move the call to 8 PM, the bill stays at 6 PM',
    operations: { open: [
      citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00'), 'Move the call to 8 PM'),
      { ref: 'i2', op: 'keep' },
    ] },
  });
  assert.deepEqual(update.next.proposal!.items.map((item) => item.resolvedTime), [at(TOMORROW, '20:00'), at(TOMORROW, '18:00')]);

  const add = await mutationTwoTurn({
    label: 'C24-add',
    message: 'The call stays at 5 PM, also buy bread at 7 PM',
    operations: {
      open: [{ ref: 'i1', op: 'keep' }],
      added: [citedAdd(modelItem('Buy bread', '2026-10-07', '19:00'), 'also buy bread at 7 PM')],
    },
  });
  assert.equal(itemWith(add.next.proposal, 'Buy bread').resolvedTime, at('2026-10-07', '19:00'));
});

async function thoughtKindMutation(
  message: string,
  update: ReturnType<typeof modelRefAnswer>,
): Promise<GateProposal> {
  const first = modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]);
  const thought = modelRefAnswer('Added thought.', 'update', {
    open: [{ ref: 'i1', op: 'keep' }],
    added: [citedAdd(modelItem('Travel next summer', null, null, { kind: 'consideration' }), "I'm thinking about traveling next summer")],
  });
  const uid = beginGateModel(first, thought, update);
  try {
    const one = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
    await gateChat(uid, "I'm thinking about traveling next summer", { conversationId: one.conversationId, locale: 'en' });
    const changed = await gateChat(uid, message, { conversationId: one.conversationId, locale: 'en' });
    return changed.proposal!;
  } finally {
    endGate();
  }
}

test('F4 a thought stays a thought when its span adds details but no new intent', async () => {
  const proposal = await thoughtKindMutation('with my sister, tomorrow evening', modelRefAnswer('Updated.', 'update', {
    open: [
      { ref: 'i1', op: 'keep' },
      citedUpdate('s1', modelItem('Travel next summer with my sister', TOMORROW, '18:00'), 'with my sister, tomorrow evening'),
    ],
  }));
  assert.equal(proposal.items.some((item) => /Travel/i.test(item.title)), false);
  assert.equal(seedWith(proposal, 'traveling').kind, 'consideration');
});

test('F6 a thought changes kind when its own newest span states the new intent', async () => {
  const proposal = await thoughtKindMutation("I'm waiting for my boss to reply about it", modelRefAnswer('Waiting.', 'update', {
    open: [
      { ref: 'i1', op: 'keep' },
      citedUpdate('s1', modelItem('Travel next summer', null, null, { kind: 'waiting_for' }), "I'm waiting for my boss to reply about it"),
    ],
  }));
  assert.equal(seedWith(proposal, 'traveling').kind, 'waiting_for');
});

test('O5 a goal operation keeps its index before split session operations', async () => {
  const { next } = await mutationTwoTurn({
    label: 'O5',
    message: 'I want to learn React and study on Tuesday and Thursday evenings at 7 PM',
    operations: { open: [{ ref: 'i1', op: 'keep' }], added: [
      citedAdd(modelItem('Learn React', '2026-10-13', '19:00'), 'I want to learn React'),
      citedAdd(modelItem('Study on Tuesday', '2026-10-13', '19:00'), 'and study on Tuesday'),
      citedAdd(modelItem('Study on Thursday', '2026-10-08', '19:00'), 'and Thursday evenings at 7 PM'),
    ] },
  });
  assert.equal(next.proposal!.seeds[0]?.kind, 'possible_goal', JSON.stringify(next.proposal));
  assert.match(next.proposal!.seeds[0]?.summary ?? '', /learn React/i);
  assert.deepEqual(next.proposal!.items.filter((item) => /Study/.test(item.title)).map((item) => item.resolvedDate).sort(), ['2026-10-08', '2026-10-13']);
});

test('C26 one cited recurring update fans one stored session out to both named days', async () => {
  const first = modelFirstAnswer('Review.', 'propose', [
    modelItem('Learn React', '2026-10-13', '19:00'),
    modelItem('Study on Tuesday', '2026-10-13', '19:00'),
    modelItem('Study on Thursday', '2026-10-08', '19:00'),
  ]);
  const second = modelRefAnswer('Updated.', 'update', {
    open: [
      { ref: 's1', op: 'keep' },
      citedUpdate('i1', modelItem('Study every Tuesday and Thursday', '2026-10-13', '19:00'), 'Every Tuesday and Thursday at 7 PM'),
      { ref: 'i2', op: 'remove' },
    ],
  });
  const uid = beginGateModel(first, second);
  try {
    const one = await gateChat(uid, 'I want to learn React and study on Tuesday and Thursday evenings at 7 PM', { locale: 'en' });
    const two = await gateChat(uid, 'Every Tuesday and Thursday at 7 PM', { conversationId: one.conversationId, locale: 'en' });
    assert.deepEqual(two.proposal!.items.filter((item) => /Study/.test(item.title)).map((item) => item.resolvedDate).sort(), ['2026-10-08', '2026-10-13']);
    assert.equal(two.proposal!.seeds.some((seed) => /Learn React/i.test(seed.summary)), true);
  } finally {
    endGate();
  }
});

test('G3 a citation cannot begin inside a word after an Arabic proclitic', async () => {
  const { first, next } = await mutationTwoTurn({
    label: 'G3-midword',
    firstMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا',
    firstItems: [modelItem('اتصل بأمي', TOMORROW, '17:00')],
    message: 'خليها الساعة 8 المسا ولازم اشتري خبز',
    operations: {
      open: [citedUpdate('i1', modelItem('اتصل بأمي', TOMORROW, '20:00'), 'خليها الساعة 8 المسا')],
      added: [citedAdd(modelItem('اشتري خبز', null, null), 'ازم اشتري خبز')],
    },
    locale: 'ar',
  });
  assert.deepEqual(next.proposal!.items.map((item) => item.itemId), first.proposal!.items.map((item) => item.itemId));
  assert.match(next.reply, /ما قدرت أطبّق/);
});

test('G4 a citation may omit one leading Arabic lam proclitic', async () => {
  const { next } = await mutationTwoTurn({
    label: 'G4-lam',
    firstMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا',
    firstItems: [modelItem('اتصل بأمي', TOMORROW, '17:00')],
    message: 'خليها لبعد بكرا الساعة 8 المسا',
    operations: { open: [citedUpdate('i1', modelItem('اتصل بأمي', '2026-10-09', '20:00'), 'بعد بكرا الساعة 8 المسا')] },
    locale: 'ar',
  });
  assert.equal(itemWith(next.proposal, 'اتصل بأمي').resolvedTime, at('2026-10-09', '20:00'));
});

test('R72 missing operation indices roll back instead of pairing by output position', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review.', 'propose', [
      modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('Done.', 'update', {
      open: [
        citedUpdate('i1', { ...modelItem('Broken', TOMORROW, '17:00'), title: '', action: '' }, 'Call mom'),
        { ref: 'i2', op: 'keep' },
      ],
      added: [citedAdd(modelItem('Go to the gym', '2026-10-13', '19:00'), 'go to the gym every Tuesday and Thursday at 7 PM')],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', { locale: 'en' });
    const next = await gateChat(uid, 'Call mom. Also go to the gym every Tuesday and Thursday at 7 PM', {
      conversationId: first.conversationId, locale: 'en',
    });
    assert.deepEqual(next.proposal!.items.map((item) => [item.itemId, item.title]), first.proposal!.items.map((item) => [item.itemId, item.title]));
    assert.equal(next.proposal!.items.some((item) => /gym/i.test(item.title)), false);
    assert.match(next.reply, /couldn.t apply|could not apply/i);
  } finally {
    endGate();
  }
});

test('V1 shared or overlapping citations with point-specific day/time facts roll back atomically', async () => {
  for (const [message, firstSource, secondSource, firstFields, secondFields] of [
    [
      'Move the call to Friday and the bill to 8 PM',
      'Move the call to Friday and the bill to 8 PM',
      'Move the call to Friday and the bill to 8 PM',
      modelItem('Call mom', '2026-10-09', '17:00'), modelItem('Pay the bill', TOMORROW, '20:00'),
    ],
    [
      'Move the call to 8 PM and the bill to 9 PM',
      'Move the call to 8 PM and the bill to 9 PM',
      'the bill to 9 PM',
      modelItem('Call mom', TOMORROW, '20:00'), modelItem('Pay the bill', TOMORROW, '21:00'),
    ],
    [
      'خلي الاتصال يوم الجمعة والفاتورة الساعة 8 المسا',
      'خلي الاتصال يوم الجمعة والفاتورة الساعة 8 المسا',
      'خلي الاتصال يوم الجمعة والفاتورة الساعة 8 المسا',
      modelItem('Call mom', '2026-10-09', '17:00'), modelItem('Pay the bill', TOMORROW, '20:00'),
    ],
  ] as const) {
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00')]),
      modelRefAnswer('Moved both.', 'update', { open: [
        citedUpdate('i1', firstFields, firstSource), citedUpdate('i2', secondFields, secondSource),
      ] }),
    );
    try {
      const first = await gateChat(uid, 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', { locale: 'en' });
      const next = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'en' });
      assert.deepEqual(next.proposal!.items.map((item) => [item.itemId, item.resolvedTime]), first.proposal!.items.map((item) => [item.itemId, item.resolvedTime]), message);
      assert.match(next.reply, /time wasn't clear/i);
    } finally {
      endGate();
    }
  }
});

test('V1 normalises dueAt/remindAt clocks and still rejects B1-B6, H7 and H8 shared-span mutations', async () => {
  const noSpec = (fields: Record<string, unknown>) => ({ ...fields, localTimeSpec: null });
  const friday = '2026-10-09';
  const englishFirst = [modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00')];
  const arabicFirst = [modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00')];
  const cases = [
    {
      label: 'B1', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Move the call to 8 PM and rename the bill to electricity bill',
      fields: [modelItem('Call mom', TOMORROW, '20:00'), noSpec(modelItem('Electricity bill', TOMORROW, '18:00'))],
    },
    {
      label: 'B2', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Move the call to Friday and the bill to 8 PM',
      fields: [modelItem('Call mom', friday, '17:00'), noSpec(modelItem('Pay the bill', TOMORROW, '20:00'))],
    },
    {
      label: 'B3', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Move the call to Friday and the bill to 8 PM',
      fields: [noSpec(modelItem('Call mom', friday, '17:00')), modelItem('Pay the bill', TOMORROW, '20:00')],
    },
    {
      label: 'B4', locale: 'ar' as const,
      firstMessage: 'لازم اتصل بأمي بكرا الساعة 5 المسا، وادفع الفاتورة بكرا الساعة 6 المسا', firstItems: arabicFirst,
      message: 'خلي الاتصال الساعة 8 المسا وسمّي الفاتورة فاتورة الكهربا',
      fields: [modelItem('اتصل بأمي', TOMORROW, '20:00'), noSpec(modelItem('فاتورة الكهربا', TOMORROW, '18:00'))],
    },
    {
      label: 'B5', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Rename the call to phone mom and move the bill to 9 PM',
      fields: [noSpec(modelItem('Phone mom', TOMORROW, '17:00')), modelItem('Pay the bill', TOMORROW, '21:00')],
    },
    {
      label: 'B6 dueAt-only', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Move the call to Friday and the bill to 8 PM',
      fields: [noSpec(modelItem('Call mom', friday, '17:00')), noSpec(modelItem('Pay the bill', TOMORROW, '20:00'))],
    },
    {
      label: 'H7 two days, uniform model', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Move the call to Friday and the bill to Monday',
      fields: [modelItem('Call mom', friday, '17:00'), modelItem('Pay the bill', friday, '18:00')],
    },
    {
      label: 'H8 rename echo', locale: 'en' as const,
      firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM', firstItems: englishFirst,
      message: 'Move the call to 8 PM and rename the bill to electricity bill',
      fields: [modelItem('Call mom', TOMORROW, '20:00'), modelItem('Electricity bill', TOMORROW, '18:00')],
    },
  ];

  for (const scenario of cases) {
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', scenario.firstItems),
      modelRefAnswer('Done.', 'update', { open: [
        citedUpdate('i1', scenario.fields[0]!, scenario.message),
        citedUpdate('i2', scenario.fields[1]!, scenario.message),
      ] }),
    );
    try {
      const first = await gateChat(uid, scenario.firstMessage, { locale: scenario.locale });
      const next = await gateChat(uid, scenario.message, { conversationId: first.conversationId, locale: scenario.locale });
      assert.deepEqual(
        next.proposal!.items.map((item) => [item.itemId, item.title, item.resolvedTime]),
        first.proposal!.items.map((item) => [item.itemId, item.title, item.resolvedTime]),
        scenario.label,
      );
      const timeMismatch = scenario.label !== 'H7 two days, uniform model';
      assert.match(
        next.reply,
        timeMismatch
          ? scenario.locale === 'ar' ? /الساعة مش واضحة/ : /time wasn't clear/i
          : /couldn.t apply|could not apply/i,
        scenario.label,
      );
    } finally {
      endGate();
    }
  }
});

test('V2 chat answers to ask_am_pm preserve the asked hour and minute in ar, en and he', async () => {
  const wordCases = [
    ['ar', 'المسا', 'pm'], ['ar', 'بالليل', 'pm'], ['ar', 'الصبح', 'am'],
    ['en', 'in the evening', 'pm'], ['en', 'PM', 'pm'], ['en', 'AM', 'am'], ['en', 'morning', 'am'],
    ['he', 'בערב', 'pm'], ['he', 'בלילה', 'pm'], ['he', 'בבוקר', 'am'],
  ] as const;
  const cases = [
    ...wordCases.map(([locale, word, half]) => [locale, word, half, 7] as const),
    ...(['ar', 'en', 'he'] as const).flatMap((locale) => Array.from({ length: 11 }, (_, index) => [
      locale, locale === 'ar' ? 'المسا' : locale === 'he' ? 'בערב' : 'PM', 'pm', index + 1,
    ] as const)),
  ];
  for (const [locale, word, half, hour] of cases) {
    const asked = `make it at ${hour}:30`;
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
      modelRefAnswer('Morning or evening?', 'update', { open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, `${String(hour).padStart(2, '0')}:30`), asked)] }),
      modelRefAnswer('Done.', 'update', { open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, half === 'am' ? '09:00' : '18:00'), word)] }),
    );
    try {
      const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale });
      const question = await gateChat(uid, asked, { conversationId: first.conversationId, locale });
      assert.equal(question.proposal!.items[0]!.clarification?.questionKey, 'ask_am_pm', `${locale} ${hour}`);
      const answered = await gateChat(uid, word, { conversationId: first.conversationId, locale });
      const expectedHour = half === 'am' ? hour % 12 : (hour % 12) + 12;
      assert.equal(answered.proposal!.items[0]!.resolvedTime, at(TOMORROW, `${String(expectedHour).padStart(2, '0')}:30`), `${locale} ${word} ${hour}`);
      assert.equal(answered.proposal!.items[0]!.needsClarification, false);
    } finally {
      endGate();
    }
  }
});

test('W1 an AM/PM answer accepts a matching stated clock or an exactly bare day part', async () => {
  const friday = '2026-10-09';
  const saturday = '2026-10-10';
  const cases = [
    ['ar', 'لا، المسا', TOMORROW, '18:00', TOMORROW, '19:30'],
    ['ar', 'لا، 8 المسا', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['ar', 'الساعة 8 بالليل', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['ar', 'المسا الساعة 8', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['ar', 'بعد بكرا المسا', friday, '18:00', TOMORROW, null],
    ['en', 'no, in the evening', TOMORROW, '18:00', TOMORROW, '19:30'],
    ['en', '8 in the evening', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['en', 'evening at 8', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['en', 'no, 9 in the morning', TOMORROW, '09:00', TOMORROW, '09:00'],
    ['en', 'Saturday evening', saturday, '18:00', TOMORROW, null],
    ['he', 'לא, בערב', TOMORROW, '18:00', TOMORROW, '19:30'],
    ['he', 'לא, 8 בערב', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['he', 'בשעה 8 בלילה', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['he', 'בערב בשעה 8', TOMORROW, '20:00', TOMORROW, '20:00'],
    ['he', 'מחרתיים בערב', friday, '18:00', TOMORROW, null],
  ] as const;
  const titles = { ar: 'اتصل بأمي', en: 'Call mom', he: 'להתקשר לאמא' } as const;
  const firstMessages = {
    ar: 'اتصل بأمي بكرا الساعة 5 المسا',
    en: 'Call mom tomorrow at 5 PM',
    he: 'להתקשר לאמא מחר בשעה 5 אחר הצהריים',
  } as const;
  const ask = 'make it at 7:30';

  for (const [locale, answerText, modelDate, modelTime, expectedDate, expectedTime] of cases) {
    const title = titles[locale];
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', [modelItem(title, TOMORROW, '17:00')]),
      modelRefAnswer('Morning or evening?', 'update', {
        open: [citedUpdate('i1', modelItem(title, TOMORROW, '19:30'), ask)],
      }),
      modelRefAnswer('Done.', 'update', {
        open: [citedUpdate('i1', modelItem(title, modelDate, modelTime), answerText)],
      }),
    );
    try {
      const first = await gateChat(uid, firstMessages[locale], { locale });
      const asking = await gateChat(uid, ask, { conversationId: first.conversationId, locale });
      assert.equal(asking.proposal!.items[0]!.clarification?.questionKey, 'ask_am_pm', `${locale}: ${answerText}`);
      const answered = await gateChat(uid, answerText, { conversationId: first.conversationId, locale });
      assert.equal(
        answered.proposal!.items[0]!.resolvedTime,
        expectedTime === null ? null : at(expectedDate, expectedTime),
        `${locale}: ${answerText}`,
      );
      assert.equal(answered.proposal!.items[0]!.needsClarification, expectedTime === null, `${locale}: ${answerText}`);
      if (expectedTime === null) assert.equal(answered.proposal!.proposalId, asking.proposal!.proposalId, `${locale}: ${answerText}`);
    } finally {
      endGate();
    }
  }
});

test('W4 one shared day part resolves each asking point from its own stored hour', async () => {
  for (const scenario of [
    { locale: 'en' as const, answer: 'both in the evening', modelTimes: ['19:00', '20:00'] as const },
    { locale: 'ar' as const, answer: 'التنين المسا', modelTimes: ['18:00', '18:00'] as const },
  ]) {
    const firstMessage = scenario.locale === 'ar'
      ? 'اتصل بأمي بكرا الساعة 5 المسا وادفع الفاتورة بكرا الساعة 6 المسا'
      : 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM';
    const titles = scenario.locale === 'ar' ? ['اتصل بأمي', 'ادفع الفاتورة'] as const : ['Call mom', 'Pay the bill'] as const;
    const bareMessage = scenario.locale === 'ar' ? 'خلي الاتصال الساعة 7:00 والفاتورة الساعة 8:00' : 'Move the call to 7:00 and the bill to 8:00';
    const firstSource = scenario.locale === 'ar' ? 'خلي الاتصال الساعة 7:00' : 'Move the call to 7:00';
    const secondSource = scenario.locale === 'ar' ? 'والفاتورة الساعة 8:00' : 'and the bill to 8:00';
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', [modelItem(titles[0], TOMORROW, '17:00'), modelItem(titles[1], TOMORROW, '18:00')]),
      modelRefAnswer('Morning or evening?', 'update', { open: [
        citedUpdate('i1', modelItem(titles[0], TOMORROW, '19:00'), firstSource),
        citedUpdate('i2', modelItem(titles[1], TOMORROW, '20:00'), secondSource),
      ] }),
      modelRefAnswer('Done.', 'update', { open: [
        citedUpdate('i1', modelItem(titles[0], TOMORROW, scenario.modelTimes[0]), scenario.answer),
        citedUpdate('i2', modelItem(titles[1], TOMORROW, scenario.modelTimes[1]), scenario.answer),
      ] }),
    );
    try {
      const first = await gateChat(uid, firstMessage, { locale: scenario.locale });
      const asking = await gateChat(uid, bareMessage, { conversationId: first.conversationId, locale: scenario.locale });
      assert.deepEqual(asking.proposal!.items.map((item) => item.clarification?.questionKey), ['ask_am_pm', 'ask_am_pm']);
      const answered = await gateChat(uid, scenario.answer, { conversationId: first.conversationId, locale: scenario.locale });
      assert.deepEqual(answered.proposal!.items.map((item) => item.resolvedTime), [at(TOMORROW, '19:00'), at(TOMORROW, '20:00')], scenario.answer);
    } finally {
      endGate();
    }
  }
});

test('V3 one bare clock asks without clearing another operation\u2019s stated time', async () => {
  const { next } = await mutationTwoTurn({
    label: 'V3',
    message: 'Move the call to 8 PM. Also buy bread tomorrow at 7',
    operations: {
      open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00'), 'Move the call to 8 PM.')],
      added: [citedAdd(modelItem('Buy bread', TOMORROW, '19:00'), 'Also buy bread tomorrow at 7')],
    },
  });
  assert.equal(itemWith(next.proposal, 'Call mom').resolvedTime, at(TOMORROW, '20:00'));
  assert.equal(itemWith(next.proposal, 'Buy bread').clarification?.questionKey, 'ask_am_pm');
});

test('W3 swapped point citations never save the other point’s hour', async () => {
  const message = 'Move the call to 8 PM. Also buy bread tomorrow at 7 PM.';
  const cases = [
    {
      label: 'X1 model fields right',
      update: citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00'), 'Also buy bread tomorrow at 7 PM.'),
      added: citedAdd(modelItem('Buy bread', TOMORROW, '19:00'), 'Move the call to 8 PM.'),
    },
    {
      label: 'X1b model fields match the swapped citations',
      update: citedUpdate('i1', modelItem('Call mom', TOMORROW, '19:00'), 'Also buy bread tomorrow at 7 PM.'),
      added: citedAdd(modelItem('Buy bread', TOMORROW, '20:00'), 'Move the call to 8 PM.'),
    },
    {
      label: 'X1c update cites only the other clock',
      update: citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00'), 'tomorrow at 7 PM'),
      added: citedAdd(modelItem('Buy bread', TOMORROW, '20:00'), 'Move the call to 8 PM. Also buy bread'),
    },
  ];
  for (const scenario of cases) {
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
      modelRefAnswer('Done.', 'update', { open: [scenario.update], added: [scenario.added] }),
    );
    try {
      const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
      const next = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'en' });
      assert.deepEqual(
        next.proposal!.items.map((item) => [item.itemId, item.title, item.resolvedTime]),
        first.proposal!.items.map((item) => [item.itemId, item.title, item.resolvedTime]),
        scenario.label,
      );
      assert.match(
        next.reply,
        scenario.label === 'X1c update cites only the other clock'
          ? /time wasn't clear/i
          : /couldn.t apply|could not apply/i,
        scenario.label,
      );
    } finally {
      endGate();
    }
  }
});

test('V4 bare h:mm clocks from 1 through 11 ask AM or PM', async () => {
  for (let hour = 1; hour <= 11; hour += 1) {
    const message = `make it ${hour}:30`;
    const { next } = await mutationTwoTurn({
      label: `V4-${hour}`,
      message,
      operations: { open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, `${String(hour + 12).padStart(2, '0')}:30`), message)] },
    });
    assert.equal(next.proposal!.items[0]!.resolvedTime, null, `${hour}:30 settled`);
    assert.equal(next.proposal!.items[0]!.clarification?.questionKey, 'ask_am_pm');
  }
});

test('V6 invisible priority drift is a keep and the cited add beside it applies', async () => {
  const high = { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false };
  const uid = beginGateModel(
    modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Added bread.', 'update', {
      open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, '17:00'), 'I have to call mom tomorrow at 5 PM')],
      added: [citedAdd(modelItem('Buy bread', TOMORROW, '19:00'), 'Also buy bread tomorrow at 7 PM')],
    }),
  );
  try {
    const first = await gateChat(uid, 'I have to call mom tomorrow at 5 PM', { locale: 'en' });
    assert.equal((itemWith(first.proposal, 'Call mom') as any).priority, high.level);
    const next = await gateChat(uid, 'Also buy bread tomorrow at 7 PM', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(itemWith(next.proposal, 'Call mom').itemId, itemWith(first.proposal, 'Call mom').itemId);
    assert.equal(itemWith(next.proposal, 'Buy bread').resolvedTime, at(TOMORROW, '19:00'));
  } finally {
    endGate();
  }
});

test('V6 priority words affect only the operation span that cites them', async () => {
  const cases = [
    ['ar', 'لازم اشتري خبز بكرا الساعة 7 المسا', 'لازم اتصل بأمي بكرا الساعة 5 المسا', 'اتصل بأمي', 'اشتري خبز'],
    ['ar', 'ضروري اشتري خبز بكرا الساعة 7 المسا', 'لازم اتصل بأمي بكرا الساعة 5 المسا', 'اتصل بأمي', 'اشتري خبز'],
    ['ar', 'مهم اشتري خبز بكرا الساعة 7 المسا', 'لازم اتصل بأمي بكرا الساعة 5 المسا', 'اتصل بأمي', 'اشتري خبز'],
    ['ar', 'عاجل اشتري خبز بكرا الساعة 7 المسا', 'لازم اتصل بأمي بكرا الساعة 5 المسا', 'اتصل بأمي', 'اشتري خبز'],
    ['en', 'I have to buy bread tomorrow at 7 PM', 'I must call mom tomorrow at 5 PM', 'Call mom', 'Buy bread'],
    ['en', 'Important: buy bread tomorrow at 7 PM', 'Important: call mom tomorrow at 5 PM', 'Call mom', 'Buy bread'],
  ] as const;
  for (const [locale, message, firstMessage, callTitle, breadTitle] of cases) {
    const uid = beginGateModel(
      modelFirstAnswer('Review.', 'propose', [modelItem(callTitle, TOMORROW, '17:00')]),
      modelRefAnswer('Added.', 'update', {
        open: [citedUpdate('i1', modelItem(callTitle, TOMORROW, '17:00'), firstMessage)],
        added: [citedAdd(modelItem(breadTitle, TOMORROW, '19:00'), message)],
      }),
    );
    try {
      const first = await gateChat(uid, firstMessage, { locale });
      const call = itemWith(first.proposal, callTitle);
      const next = await gateChat(uid, message, { conversationId: first.conversationId, locale });
      assert.equal(itemWith(next.proposal, callTitle).itemId, call.itemId, `${locale}: ${message}`);
      assert.equal(itemWith(next.proposal, callTitle).resolvedTime, at(TOMORROW, '17:00'), `${locale}: ${message}`);
      assert.equal(itemWith(next.proposal, breadTitle).resolvedTime, at(TOMORROW, '19:00'), `${locale}: ${message}`);
    } finally {
      endGate();
    }
  }

  const uid = beginGateModel(
    modelFirstAnswer('Review.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Marked important.', 'update', {
      open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, '17:00', {
        priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureImplied: false },
      }), 'the call is a top priority')],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
    const next = await gateChat(uid, 'the call is a top priority', { conversationId: first.conversationId, locale: 'en' });
    assert.equal((itemWith(next.proposal, 'Call mom') as any).priority, 'high');
  } finally {
    endGate();
  }
});

test('citation folding covers case, digits, ta-marbuta endings and apostrophe variants', async () => {
  for (const [message, source] of [
    ['MOVE THE CALL TO 8 PM', 'move the call to 8 pm'],
    ['خليها الساعة ٨ المسا', 'خليها الساعة 8 المسا'],
    ['خلي المكالمة الساعة 8 المسا', 'خلي المكالمه الساعة 8 المسا'],
    ["Move Sara's call to 8 PM", 'Move Sara’s call to 8 PM'],
  ] as const) {
    const { next } = await mutationTwoTurn({
      label: 'citation-fold', message,
      operations: { open: [citedUpdate('i1', modelItem('Call mom', TOMORROW, '20:00'), source)] },
    });
    assert.equal(next.proposal!.items[0]!.resolvedTime, at(TOMORROW, '20:00'), `${message} / ${source}`);
  }
});

test('a one-letter citation is not a whole-word citation inside another word', async () => {
  const { first, next } = await mutationTwoTurn({
    label: 'one-letter',
    message: 'كل يوم جمعة لازم اروح عالنادي الساعة 7 المسا',
    operations: { open: [{ ref: 'i1', op: 'keep' }], added: [citedAdd(modelItem('Gym', '2026-10-09', '19:00'), 'ل')] },
    locale: 'ar',
  });
  assert.deepEqual(next.proposal!.items.map((item) => item.itemId), first.proposal!.items.map((item) => item.itemId));
  assert.match(next.reply, /ما قدرت أطبّق/);
});

test('V5 a first-turn model reply is not replaced by the generic changed template', async () => {
  const uid = beginGateModel(modelFirstAnswer('Two meetings tomorrow. Confirm below.', 'propose', [
    modelItem('Meeting', TOMORROW, '17:00'), modelItem('Meeting', TOMORROW, '18:00'),
  ]));
  try {
    const answer = await gateChat(uid, 'I have two meetings tomorrow, at 5 PM and 6 PM', { locale: 'en' });
    assert.equal(answer.reply, 'Two meetings tomorrow. Confirm below.');
    assert.notEqual(answer.reply, 'Okay, I changed that.');
  } finally {
    endGate();
  }
});

test('D4 a reply saying both moved is replaced when only one point moved', async () => {
  const { next } = await mutationTwoTurn({
    label: 'D4-both-one',
    firstMessage: 'Call mom tomorrow at 5 PM and pay the bill tomorrow at 6 PM',
    firstItems: [modelItem('Call mom', TOMORROW, '17:00'), modelItem('Pay the bill', TOMORROW, '18:00')],
    message: 'Move the call to Friday',
    reply: 'Moved both to Friday.',
    operations: { open: [
      citedUpdate('i1', modelItem('Call mom', '2026-10-09', '17:00'), 'Move the call to Friday'),
      { ref: 'i2', op: 'keep' },
    ] },
  });
  assert.notEqual(next.reply, 'Moved both to Friday.');
  assert.match(next.reply, /changed|updated/i);
});

test('V9 regenerating only a clarification id is not reported as a visible change', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('When should you call mom?', 'propose', [modelItem('Call mom', TOMORROW, null)]),
    modelRefAnswer('Okay, I made it a thought.', 'update', {
      open: [citedUpdate('i1', modelItem('Call mom', null, null, { kind: 'consideration' }), 'actually I am only thinking about it, not sure yet')],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow', { locale: 'en' });
    const next = await gateChat(uid, 'actually I am only thinking about it, not sure yet', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(next.proposal!.items.length, 1);
    assert.equal(next.proposal!.seeds.length, 0);
    assert.doesNotMatch(next.reply, /changed that|made it a thought/i);
    assert.match(next.reply, /couldn.t apply|could not apply/i);
  } finally {
    endGate();
  }
});

test('a removed locked item restores before points added on later turns', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('شلت الفاتورة.', 'update', {
      locked: [{ ref: 'i2', op: 'remove' }], open: [{ ref: 'i1', op: 'keep' }],
    }),
    modelRefAnswer('أضفت الخبز.', 'update', {
      open: [{ ref: 'i1', op: 'keep' }], added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 وادفع الفاتورة الساعة 6 المسا', { locale: 'ar' });
    const bill = first.proposal!.items[1]!;
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: bill.itemId }, { text: 'ادفع الفاتورة المعدلة' }));
    const removed = await gateChat(uid, 'شيل الفاتورة', { conversationId: first.conversationId, locale: 'ar' });
    const movedOn = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const restored = await gateEditRaw(uid, first.conversationId, {
      proposalId: movedOn.proposal!.proposalId,
      revision: revisionOf(movedOn.proposal),
      target: { itemId: bill.itemId },
      change: { restore: true },
    } as never);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    const restoredProposal = (restored.body as Answer).proposal!;
    assert.deepEqual(restoredProposal.items.map((item) => item.itemId), [first.proposal!.items[0]!.itemId, bill.itemId, movedOn.proposal!.items[1]!.itemId]);
    assert.ok((removed.proposal as GateProposal & Proposal).removedItems?.some((item) => item.itemId === bill.itemId));
  } finally {
    endGate();
  }
});

test('a locked point removed beside an add restores to its original position', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
    ]),
    modelRefAnswer('شلت الفاتورة وأضفت الخبز.', 'update', {
      locked: [{ ref: 'i2', op: 'remove' }],
      open: [{ ref: 'i1', op: 'keep' }],
      added: [modelItem('اشتري خبز', TOMORROW, '19:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 وادفع الفاتورة الساعة 6 المسا', { locale: 'ar' });
    const [call, bill] = first.proposal!.items;
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: bill!.itemId }, { text: 'ادفع فاتورة الكهربا' }));
    const changed = await gateChat(uid, 'شيل الفاتورة ولازم اشتري خبز بكرا الساعة 7 المسا', {
      conversationId: first.conversationId, locale: 'ar',
    });
    const bread = itemWith(changed.proposal, 'اشتري خبز');
    const restored = await gateEditRaw(uid, first.conversationId, {
      proposalId: changed.proposal!.proposalId,
      revision: revisionOf(changed.proposal),
      target: { itemId: bill!.itemId },
      change: { restore: true },
    } as never);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.deepEqual((restored.body as Answer).proposal!.items.map((item) => item.itemId), [call!.itemId, bill!.itemId, bread.itemId]);
  } finally {
    endGate();
  }
});

test('two kept seeds remain locked across a model turn and neither can be promoted', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
      modelItem('أتعلم العبرية', null, null, { kind: 'idea' }),
    ]),
    modelRefAnswer('أضفت الخبز.', 'update', {
      locked: [{ ref: 's2', op: 'keep' }],
      open: [{ ref: 's1', op: 'update', fields: modelItem('أسافر عالبحر', TOMORROW, '17:00') }],
      added: [modelItem('اشتري خبز', TOMORROW, '18:00')],
    }),
  );
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي، وعم بفكر أتعلم العبرية', { locale: 'ar' });
    for (const seed of first.proposal!.seeds) {
      assert.equal((await keepSeedRaw(uid, {
        proposalId: first.proposal!.proposalId, seedItemId: seed.seedItemId, revision: revisionOf(first.proposal),
      })).status, 201);
    }
    const next = await gateChat(uid, 'وكمان لازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.seeds[0]!.summary, first.proposal!.seeds[0]!.summary, 'the model updated a kept seed');
    for (let index = 0; index < next.proposal!.seeds.length; index += 1) {
      const seed = next.proposal!.seeds[index]!;
      assertEditInvalid(await gateEditRaw(uid, first.conversationId, editOf(next, { seedItemId: seed.seedItemId }, {
        kind: 'commitment', time: { at: at(LATER, '17:00'), timeZone: ZONE },
      })), `kept seed ${index + 1} after a later turn`);
    }
  } finally {
    endGate();
  }
});

test('a removed kept seed keeps its original public kind', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع القائمة.', 'propose', [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })]),
    modelRefAnswer('شلت الفكرة.', 'update', { locked: [{ ref: 's1', op: 'remove' }] }),
  );
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    const travel = first.proposal!.seeds[0]!;
    assert.equal((await keepSeedRaw(uid, {
      proposalId: first.proposal!.proposalId, seedItemId: travel.seedItemId, revision: revisionOf(first.proposal),
    })).status, 201);
    const removed = await gateChat(uid, 'شيل فكرة السفر', { conversationId: first.conversationId, locale: 'ar' });
    assert.deepEqual((removed.proposal as GateProposal & Proposal).removedItems, [
      { seedItemId: travel.seedItemId, kind: 'consideration', text: travel.summary },
    ]);
  } finally {
    endGate();
  }
});

test('a clarification answer locks that item against a later model update', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('أي ساعة؟', 'ask', [modelItem('اتصل بأمي', TOMORROW, null)]),
    modelRefAnswer('تمام، غيّرتها.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('اتصل بأمي', TOMORROW, '18:00') }],
    }),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا', { locale: 'ar' });
    const call = first.proposal!.items[0]!;
    const clarified = await clarifyRaw(uid, first.proposal!, call, { freeText: 'الساعة 9 الصبح' });
    assert.equal(clarified.status, 200, JSON.stringify(clarified.body));
    const next = await gateChat(uid, 'خلي الاتصال الساعة 6', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(next.proposal, call.itemId).resolvedTime, at(TOMORROW, '09:00'));
  } finally {
    endGate();
  }
});

test('random hostile model operations never change a locked item or hide it outside removedItems', async () => {
  let state = 0x51f15e;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const mode = Math.floor(random() * 5);
    const hostileLocked = mode === 0
      ? [{ ref: 'i1', op: 'update', fields: modelItem('استبدال عدائي', TOMORROW, '20:00') }]
      : mode === 1 ? [{ ref: 'invented', op: 'remove' }, { ref: 'i1', op: 'keep' }, { ref: 'i1', op: 'remove' }]
        : mode === 2 ? [{ ref: 'i1', op: 'remove' }]
          : mode === 3 ? []
            : [{ ref: 'i1', op: 'keep', fields: modelItem('malformed', TOMORROW, '20:00') }];
    const hostileOpen = mode === 3
      ? [{ ref: 'i1', op: 'update', fields: modelItem('استبدال عدائي', TOMORROW, '20:00') }]
      : [{ ref: 'i2', op: random() < 0.5 ? 'keep' : 'remove' }];
    const uid = beginGateModel(
      { reply: 'راجع القائمة.', action: 'propose', locked: [], open: [], added: [
        modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('ادفع الفاتورة', TOMORROW, '18:00'),
      ] },
      { reply: 'حدّثت القائمة.', action: 'update', locked: hostileLocked, open: hostileOpen, added: [] },
    );
    try {
      const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 وادفع الفاتورة الساعة 6 المسا', { locale: 'ar' });
      const call = itemWith(first.proposal, 'اتصل بأمي');
      await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
      const next = await gateChat(uid, `تمام ${iteration}`, { conversationId: first.conversationId, locale: 'ar' });
      const surviving = next.proposal!.items.find((item) => item.itemId === call.itemId);
      const removed = (next.proposal as GateProposal & Proposal).removedItems?.find((item) => item.itemId === call.itemId);
      assert.ok(Boolean(surviving) !== Boolean(removed), `iteration ${iteration}: locked identity must be current or visibly removed`);
      assert.equal(surviving?.title ?? removed?.text, 'اتصل بأختي', `iteration ${iteration}: locked fields changed`);
    } finally {
      endGate();
    }
  }
});

/* ── capture-chat-v9: every changed point proves itself with its citation ── */

test('v9 citations isolate a timed update from an untimed or independently timed add', async () => {
  for (const [label, message, breadDate, breadTime] of [
    ['untimed', 'Move the call to 8 PM. Also buy bread.', null, null],
    ['timed', 'Move the call to 8 PM. Also buy bread tomorrow at 7 PM.', TOMORROW, '19:00'],
  ] as const) {
    const breadSource = label === 'timed' ? 'Also buy bread tomorrow at 7 PM.' : 'Also buy bread.';
    const uid = beginGateModel(
      modelFirstAnswer('Review it.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
      modelRefAnswer('Updated.', 'update', {
        open: [{ ref: 'i1', op: 'update', fields: modelItem('Call mom', TOMORROW, '20:00'), source: 'Move the call to 8 PM.' } as any],
        added: [{ ...modelItem('Buy bread', breadDate, breadTime), source: breadSource }],
      }),
    );
    try {
      const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
      const next = await gateChat(uid, message, { conversationId: first.conversationId, locale: 'en' });
      assert.equal(itemWith(next.proposal, 'Call mom').resolvedTime, at(TOMORROW, '20:00'), label);
      const bread = itemWith(next.proposal, 'Buy bread');
      assert.equal(bread.resolvedTime, breadTime ? at(TOMORROW, breadTime) : null, label);
      assert.equal(bread.needsClarification, breadTime === null, label);
    } finally {
      endGate();
    }
  }
});

test('v9 remove beside an untimed add keeps a truthful removedItems receipt and asks only for the add', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Updated.', 'update', {
      open: [{ ref: 'i1', op: 'remove', source: 'Forget the call at 5 PM.' } as any],
      added: [{ ...modelItem('Buy bread', null, null), source: 'I need to buy bread.' }],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
    const next = await gateChat(uid, 'Forget the call at 5 PM. I need to buy bread.', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(next.proposal!.items.length, 1, JSON.stringify(next.proposal));
    assert.equal(itemWith(next.proposal, 'Buy bread').needsClarification, true);
    assert.deepEqual((next.proposal as GateProposal & Proposal).removedItems?.map((item) => item.text), ['Call mom']);
  } finally {
    endGate();
  }
});

for (const scenario of [
  {
    label: 'Arabic', locale: 'ar' as const, first: 'عم بفكر أسافر الصيف الجاي',
    next: 'يمكن بالطيارة، وكمان لازم اشتري خبز بكرا الساعة 7 المسا',
    thoughtSource: 'يمكن بالطيارة', breadSource: 'وكمان لازم اشتري خبز بكرا الساعة 7 المسا',
    refined: 'أسافر الصيف الجاي بالطيارة', bread: 'اشتري خبز',
  },
  {
    label: 'English', locale: 'en' as const, first: "I'm thinking about traveling next summer",
    next: 'maybe by plane. And I need to buy bread tomorrow at 7 PM',
    thoughtSource: 'maybe by plane.', breadSource: 'And I need to buy bread tomorrow at 7 PM',
    refined: 'Travel next summer by plane', bread: 'Buy bread',
  },
] as const) test(`v9 ${scenario.label} thought refinement and bread add use only their own spans`, async () => {
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [modelItem(scenario.locale === 'ar' ? 'أسافر الصيف الجاي' : 'Travel next summer', null, null, { kind: 'consideration' })]),
    modelRefAnswer('Updated.', 'update', {
      open: [{ ref: 's1', op: 'update', fields: modelItem(scenario.refined, null, null, { kind: 'consideration' }), source: scenario.thoughtSource } as any],
      added: [{ ...modelItem(scenario.bread, TOMORROW, '19:00'), source: scenario.breadSource }],
    }),
  );
  try {
    const first = await gateChat(uid, scenario.first, { locale: scenario.locale });
    const next = await gateChat(uid, scenario.next, { conversationId: first.conversationId, locale: scenario.locale });
    assert.equal(next.proposal!.seeds[0]?.kind, 'consideration', JSON.stringify(next.proposal));
    assert.match(next.proposal!.seeds[0]!.summary.toLowerCase(), /بالطيارة|plane/);
    assert.equal(itemWith(next.proposal, scenario.bread).resolvedTime, at(TOMORROW, '19:00'));
  } finally {
    endGate();
  }
});

test('v9 Arabic thought refinement beside an untimed study add preserves both kinds', async () => {
  const uid = beginGateModel(
    modelFirstAnswer('راجع.', 'propose', [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })]),
    modelRefAnswer('راجع.', 'update', {
      open: [{ ref: 's1', op: 'update', fields: modelItem('أسافر الصيف الجاي بالطيارة', null, null, { kind: 'consideration' }), source: 'يمكن بالطيارة' } as any],
      added: [{ ...modelItem('ادرس', null, null), source: 'ولازم ادرس' }],
    }),
  );
  try {
    const first = await gateChat(uid, 'عم بفكر أسافر الصيف الجاي', { locale: 'ar' });
    const next = await gateChat(uid, 'يمكن بالطيارة، ولازم ادرس', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(next.proposal!.seeds[0]?.kind, 'consideration', JSON.stringify(next.proposal));
    assert.equal(itemWith(next.proposal, 'ادرس').needsClarification, true);
  } finally {
    endGate();
  }
});

test('v9 calendar-date citations move an existing point and preserve its stored hour', async () => {
  for (const [label, message, source, expectedDate, locale] of [
    ['month day', 'Move the call to October 20', 'Move the call to October 20', '2026-10-20', 'en'],
    ['ordinal', 'Move the call to the 20th', 'Move the call to the 20th', '2026-10-20', 'en'],
    ['numeric', 'Move the call to 20/10', 'Move the call to 20/10', '2026-10-20', 'en'],
    ['Arabic day', 'خلي الاتصال يوم 20', 'خلي الاتصال يوم 20', '2026-10-20', 'ar'],
    ['relative', 'Move the call in 3 days', 'Move the call in 3 days', '2026-10-10', 'en'],
  ] as const) {
    const title = locale === 'ar' ? 'اتصل بأمي' : 'Call mom';
    const uid = beginGateModel(
      modelFirstAnswer('Review it.', 'propose', [modelItem(title, TOMORROW, '17:00')]),
      modelRefAnswer('Moved.', 'update', {
        open: [{ ref: 'i1', op: 'update', fields: modelItem(title, expectedDate, '17:00'), source } as any],
      }),
    );
    try {
      const first = await gateChat(uid, locale === 'ar' ? 'لازم اتصل بأمي بكرا الساعة 5 المسا' : 'Call mom tomorrow at 5 PM', { locale });
      const next = await gateChat(uid, message, { conversationId: first.conversationId, locale });
      assert.equal(itemWith(next.proposal, title).resolvedTime, at(expectedDate, '17:00'), label);
    } finally {
      endGate();
    }
  }
});

test('v9 a calendar-date answer closes an asking item even when the model supplies the instant only', async () => {
  const dueOnly = { ...modelItem('Call mom', '2026-10-20', '17:00'), localTimeSpec: null };
  const uid = beginGateModel(
    modelFirstAnswer('When?', 'ask', [modelItem('Call mom', null, null)]),
    modelRefAnswer('Moved.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: dueOnly, source: 'October 20 at 5 PM' } as any],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom', { locale: 'en' });
    const next = await gateChat(uid, 'October 20 at 5 PM', { conversationId: first.conversationId, locale: 'en' });
    const call = itemWith(next.proposal, 'Call mom');
    assert.equal(call.resolvedTime, at('2026-10-20', '17:00'));
    assert.equal(call.needsClarification, false, JSON.stringify(call));
    assert.doesNotMatch(next.reply, /what time|which day/i);
  } finally {
    endGate();
  }
});

test('v9 a day move and a rename preserve a cited range end', async () => {
  const friday = '2026-10-09';
  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [modelItem('Meeting', TOMORROW, '16:00', { rangeMinutes: 120 })]),
    modelRefAnswer('Moved.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('Meeting', friday, '16:00'), source: 'Move the meeting to Friday' } as any],
    }),
    modelRefAnswer('Renamed.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('Team meeting', friday, '16:00'), source: 'Call it Team meeting' } as any],
    }),
  );
  try {
    const first = await gateChat(uid, 'Meeting tomorrow from 4 to 6 PM', { locale: 'en' });
    assert.equal(itemWith(first.proposal, 'Meeting').endTime, at(TOMORROW, '18:00'));
    const moved = await gateChat(uid, 'Move the meeting to Friday', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(itemWith(moved.proposal, 'Meeting').endTime, at(friday, '18:00'));
    const renamed = await gateChat(uid, 'Call it Team meeting', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(itemWith(renamed.proposal, 'Team meeting').endTime, at(friday, '18:00'));
  } finally {
    endGate();
  }
});

test('v9 kind promotion keeps understood and a weekly offer follows the point current fields', async () => {
  let uid = beginGateModel(
    modelFirstAnswer('راجع.', 'propose', [modelItem('أحجز الطيارة', null, null, { kind: 'consideration' })]),
    modelRefAnswer('حدّثت.', 'update', {
      open: [{ ref: 's1', op: 'update', fields: modelItem('احجز الطيارة', TOMORROW, '10:00'), source: 'لازم احجز الطيارة بكرا الساعة 10 الصبح' } as any],
    }),
  );
  try {
    const first = await gateChat(uid, 'يمكن أحجز الطيارة', { locale: 'ar' });
    const promoted = await gateChat(uid, 'لازم احجز الطيارة بكرا الساعة 10 الصبح', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemWith(promoted.proposal, 'احجز الطيارة').resolvedTime, at(TOMORROW, '10:00'));
    assertUnderstoodValid(promoted.proposal, 'promoted thought');
    const edited = await gateEdit(uid, promoted.conversationId, editOf(promoted, { itemId: promoted.proposal!.items[0]!.itemId }, { text: 'احجز تذكرة الطيارة' }));
    assertUnderstoodValid(edited.proposal, 'structured edit after promotion');
  } finally {
    endGate();
  }

  const saturday = '2026-10-10';
  uid = beginGateModel(
    modelFirstAnswer('راجع.', 'propose', [modelItem('شغل', saturday, '10:00', { rangeMinutes: 360 })]),
    modelRefAnswer('غيّرت الوقت.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('شغل', saturday, '11:00', { rangeMinutes: 360 }), source: 'خليه من 11 الصبح لـ 5 المسا' } as any],
    }),
    modelRefAnswer('غيّرت الاسم.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('دوام', saturday, '11:00'), source: 'سميه دوام' } as any],
    }),
  );
  try {
    const first = await gateChat(uid, 'عندي شغل كل سبت من الساعة 10 الصبح لـ 4 المسا', { locale: 'ar' });
    const moved = await gateChat(uid, 'خليه من 11 الصبح لـ 5 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const movedOffer = (itemWith(moved.proposal, 'شغل') as any).weeklyBlock;
    assert.deepEqual(movedOffer && { title: movedOffer.title, start: movedOffer.start, end: movedOffer.end }, { title: 'شغل', start: '11:00', end: '17:00' });
    const renamed = await gateChat(uid, 'سميه دوام', { conversationId: first.conversationId, locale: 'ar' });
    const renamedOffer = (itemWith(renamed.proposal, 'دوام') as any).weeklyBlock;
    assert.deepEqual(renamedOffer && { title: renamedOffer.title, start: renamedOffer.start, end: renamedOffer.end }, { title: 'دوام', start: '11:00', end: '17:00' });
  } finally {
    endGate();
  }
});

test('v9 invalid, overlapping, and single missing citations follow the atomic fallback rule', async () => {
  for (const [label, updateSource, addSource] of [
    ['invalid', 'words not in the message', 'Also buy bread.'],
    ['overlap', 'Move the call to 8 PM. Also buy bread.', 'Move the call to 8 PM. Also buy bread.'],
  ] as const) {
    const uid = beginGateModel(
      modelFirstAnswer('Review it.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
      modelRefAnswer('Updated.', 'update', {
        open: [{ ref: 'i1', op: 'update', fields: modelItem('Call mom', TOMORROW, '20:00'), source: updateSource } as any],
        added: [{ ...modelItem('Buy bread', null, null), source: addSource }],
      }),
    );
    try {
      const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
      const before = first.proposal!.items[0]!;
      const next = await gateChat(uid, 'Move the call to 8 PM. Also buy bread.', { conversationId: first.conversationId, locale: 'en' });
      assert.equal(next.proposal!.items.length, 1, label);
      assert.equal(next.proposal!.items[0]!.itemId, before.itemId, label);
      assert.equal(next.proposal!.items[0]!.resolvedTime, before.resolvedTime, label);
      assert.match(next.reply, /couldn.t apply|edit it on the card/i, label);
    } finally {
      endGate();
    }
  }

  const uid = beginGateModel(
    modelFirstAnswer('Review it.', 'propose', [modelItem('Call mom', TOMORROW, '17:00')]),
    modelRefAnswer('Moved.', 'update', {
      open: [{ ref: 'i1', op: 'update', fields: modelItem('Call mom', TOMORROW, '20:00') }],
    }),
  );
  try {
    const first = await gateChat(uid, 'Call mom tomorrow at 5 PM', { locale: 'en' });
    const next = await gateChat(uid, 'Move the call to 8 PM', { conversationId: first.conversationId, locale: 'en' });
    assert.equal(itemWith(next.proposal, 'Call mom').resolvedTime, at(TOMORROW, '20:00'));
  } finally {
    endGate();
  }
});

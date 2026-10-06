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
  TOMORROW,
  at,
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
  modelAnswer,
  modelCorrections,
  modelItem,
  revisionOf,
  savedCommitments,
  seedWith,
  takeModelDown,
  type Answer,
  type Proposal as GateProposal,
} from '../acceptance/m2b/support.ts';

const BASE = 'http://localhost:3000';
const ZONE = 'Asia/Jerusalem';

type Raw = { status: number; body: Record<string, any> };
type Proposal = {
  proposalId: string;
  revision: number;
  items: Array<{ itemId: string; title: string; clarification?: { questionId: string; options: Array<{ optionId: string }> } | null }>;
  seeds: Array<{ seedItemId: string; summary: string }>;
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
    modelAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelAnswer('أضفت الخبز.', 'update', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
      modelItem('اشتري خبز', TOMORROW, '18:00'),
    ]),
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
  let uid = beginGateModel(modelAnswer('راجع القائمة.', 'propose', [
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

  uid = beginGateModel(modelAnswer('راجع القائمة.', 'propose', [
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

test('D1 carries only structured fields: later model times win while edited words and unrelated kinds remain', async () => {
  let uid = beginGateModel(
    modelAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', null, null)]),
    modelAnswer('حدّثت الوقت.', 'update', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
  );
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

  uid = beginGateModel(
    modelAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '16:00')]),
    modelAnswer('حدّثت الوقت.', 'update', [modelItem('اتصل بأمي', TOMORROW, '19:00')]),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 4 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, {
      time: { at: at(LATER, '17:00'), timeZone: ZONE },
    }));
    const moved = await gateChat(uid, 'لا، الساعة 7 أحسن', { conversationId: first.conversationId, locale: 'ar' });
    assert.equal(itemById(moved.proposal, call.itemId).resolvedTime, at(TOMORROW, '19:00'));
  } finally {
    endGate();
  }

  uid = beginGateModel(
    modelAnswer('راجع القائمة.', 'propose', [modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' })]),
    modelAnswer('تمام.', 'update', [
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
      modelItem('اشتري خبز', TOMORROW, '18:00'),
    ]),
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

test('D5 a seed-kind edit survives a model list edit and the seed reaches currentProposal', async () => {
  const prompts: string[] = [];
  const answers = [
    modelAnswer('راجع القائمة.', 'propose', [
      modelItem('اتصل بأمي', TOMORROW, '17:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
    modelAnswer('غيّرت الوقت.', 'update', [
      modelItem('اتصل بأمي', TOMORROW, '19:00'),
      modelItem('أسافر الصيف الجاي', null, null, { kind: 'consideration' }),
    ]),
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
    modelAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelAnswer('أضفت الخبز.', 'update', [modelItem('اتصل بأمي', TOMORROW, '17:00'), modelItem('اشتري خبز', TOMORROW, '18:00')]),
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

test('D1 a later explicit rename replaces the earlier structured words edit', async () => {
  const uid = beginGateModel(
    modelAnswer('راجع القائمة.', 'propose', [modelItem('اتصل بأمي', TOMORROW, '17:00')]),
    modelAnswer('غيّرت الاسم.', 'update', [modelItem('اتصل بخالتي', TOMORROW, '17:00')]),
  );
  try {
    const first = await gateChat(uid, 'لازم اتصل بأمي بكرا الساعة 5 المسا', { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await gateEdit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const renamed = await gateChat(uid, 'سميها اتصل بخالتي', { conversationId: first.conversationId, locale: 'ar' });
    assert.ok(renamed.proposal!.items.some((item) => item.title === 'اتصل بخالتي'), JSON.stringify(renamed.proposal));
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
  const uid = beginGateModel(modelAnswer('راجع القائمة.', 'propose', [
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

/**
 * M2b Task B, criterion 1 (Request union, M2B-R2-002): the chat route takes
 * exactly `{ message, spoken? }` or `{ edit }`, an edit needs its
 * conversation, and the stable outcomes are 404 `conversation_not_found`,
 * 409 `{ reason: 'proposal_changed', answer }` carrying the CURRENT answer,
 * and 400 `edit_invalid`.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on d93a9a2b (the contract types only) for the reason its criterion
 * names — there the route reads every body as a message.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CAPTURE_PROPOSAL_TTL_MS } from '../../../src/contracts/v1/captureContracts.ts';
import {
  CALL_AND_TRAVEL,
  REFERENCE,
  TZ,
  advanceClock,
  assertChatConflict,
  assertEditInvalid,
  beginRules,
  chat,
  chatRaw,
  confirmRaw,
  edit,
  editOf,
  editRaw,
  end,
  itemWith,
  otherAccount,
  revisionOf,
  savedCommitments,
  seedWith,
  show,
} from './support.ts';

test('B1 request: message and edit together, an edit with spoken, an edit with no conversationId → 400; neither → 400 message_required', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const spec = editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' });
    const envelope = { timezone: TZ, referenceTime: REFERENCE };

    const both = await chatRaw(uid, { conversationId: first.conversationId, message: 'شكرا', edit: spec, ...envelope });
    assert.equal(both.status, 400, `message + edit together answered ${both.status}, not 400: ${show(both.body)}`);

    const spoken = await chatRaw(uid, { conversationId: first.conversationId, edit: spec, spoken: true, ...envelope });
    assert.equal(spoken.status, 400, `spoken on an edit answered ${spoken.status}, not 400: ${show(spoken.body)}`);

    const orphan = await chatRaw(uid, { edit: spec, ...envelope });
    assert.equal(orphan.status, 400, `an edit with no conversationId answered ${orphan.status}, not 400: ${show(orphan.body)}`);

    const neither = await chatRaw(uid, { conversationId: first.conversationId, ...envelope });
    assert.equal(neither.status, 400, `neither message nor edit answered ${neither.status}`);
    assert.equal(neither.body?.reason, 'message_required');

    // None of the refused bodies touched the proposal: the edit still applies at the first revision.
    const applied = await edit(uid, first.conversationId, spec);
    assert.equal(itemWith(applied.proposal, 'بأختي').itemId, call.itemId);
  } finally {
    end();
  }
});

test('B1 request: an edit on an unknown conversation id → 404 conversation_not_found', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const result = await editRaw(uid, randomUUID(), editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    assert.equal(result.status, 404, `an unknown conversation answered ${result.status}, not 404: ${show(result.body)}`);
    assert.equal(result.body?.reason, 'conversation_not_found');
  } finally {
    end();
  }
});

test('B1 request: an edit on another account\'s conversation → 404 conversation_not_found, and the owner\'s proposal is untouched', async () => {
  const owner = beginRules();
  try {
    const first = await chat(owner, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const spec = editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' });
    const stranger = otherAccount();
    const result = await editRaw(stranger, first.conversationId, spec);
    assert.equal(result.status, 404, `another account's conversation answered ${result.status}, not 404: ${show(result.body)}`);
    assert.equal(result.body?.reason, 'conversation_not_found');
    // The owner's edit at the revision they saw still applies: nothing moved.
    const applied = await edit(owner, first.conversationId, spec);
    assert.equal(revisionOf(applied.proposal), revisionOf(first.proposal) + 1, 'the stranger\'s edit moved the owner\'s revision');
  } finally {
    end();
  }
});

test('B1 request: an edit on an expired conversation → 404 conversation_not_found', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    advanceClock(CAPTURE_PROPOSAL_TTL_MS + 60_000);
    const result = await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    assert.equal(result.status, 404, `an expired conversation answered ${result.status}, not 404: ${show(result.body)}`);
    assert.equal(result.body?.reason, 'conversation_not_found');
  } finally {
    end();
  }
});

test('B1 request: an edit at a stale revision → 409 proposal_changed carrying the current answer (its proposal and revision)', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const newer = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    // A different edit, made on the revision the person saw before the first one landed.
    const stale = await editRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'idea' }));
    const current = assertChatConflict(stale, 'the stale edit');
    assert.equal(current.conversationId, first.conversationId);
    assert.equal(current.proposal?.proposalId, first.proposal!.proposalId, 'the 409 does not carry the current proposal');
    assert.equal(current.proposal?.revision, newer.proposal!.revision, 'the 409 does not carry the current revision');
    assert.ok(itemWith(current.proposal, 'بأختي'), 'the 409 answer is not the current one (the newer edit is missing)');
    assert.equal(current.proposal!.seeds.find((seed) => seed.seedItemId === travel.seedItemId)?.kind, 'consideration', 'the stale edit was applied');
  } finally {
    end();
  }
});

test('B1 request: an edit naming another proposal → 409 proposal_changed with this conversation\'s current answer', async () => {
  const uid = beginRules();
  try {
    const mine = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const other = await chat(uid, 'لازم اشتري خبز بكرا الساعة 6 المسا', { locale: 'ar' });
    const bread = itemWith(other.proposal, 'خبز');
    const result = await editRaw(uid, mine.conversationId, editOf(other, { itemId: bread.itemId }, { text: 'اشتري حليب' }));
    const current = assertChatConflict(result, 'an edit naming another conversation\'s proposal');
    assert.equal(current.conversationId, mine.conversationId);
    assert.equal(current.proposal?.proposalId, mine.proposal!.proposalId, 'the 409 does not carry this conversation\'s proposal');
  } finally {
    end();
  }
});

test('B1 request: an edit after the proposal was confirmed → 409 proposal_changed, and the saved commitment is unchanged', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const confirmed = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: revisionOf(first.proposal) });
    assert.equal(confirmed.status, 200, `confirm answered ${confirmed.status}: ${show(confirmed.body)}`);
    const result = await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const current = assertChatConflict(result, 'an edit after the confirm');
    assert.equal(current.conversationId, first.conversationId);
    const saved = await savedCommitments(uid);
    assert.deepEqual(saved.map((commitment) => commitment.title), ['اتصل بأمي'], 'the confirmed commitment changed after an edit');
  } finally {
    end();
  }
});

test('B1 request: an empty change, an unknown target, an unknown kind or a non-string text → 400 edit_invalid', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, {})), 'an empty change');
    assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { itemId: randomUUID() }, { text: 'اتصل بأختي' })), 'an unknown item');
    assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { seedItemId: call.itemId }, { kind: 'idea' })), 'an item id named as a seed');
    assertEditInvalid(
      await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { kind: 'task' as never })),
      'a kind that is not one of the five',
    );
    assertEditInvalid(
      await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 42 as never })),
      'a non-string text',
    );
  } finally {
    end();
  }
});

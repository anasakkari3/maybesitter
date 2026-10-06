/**
 * M2b Task B, criterion 1b (Revisions, atomicity, idempotency — M2B-REV-001/002,
 * v4 M2B-REV3-004): stored proposals carry `revision` (sent on the answer); an
 * edit is one atomic write that checks the revision and not-confirmed and
 * writes `revision+1`, the turn pair and a receipt; an identical retry replays
 * its answer (no second turn); a true no-op is `edit_invalid`; the confirm
 * saves exactly the revision it read in its own transaction; only the current
 * receipt is kept.
 *
 * Interleavings are driven deterministically in-process on the memory store
 * (sequenced, and with `Promise.all` where the store's FIFO transaction lock
 * makes the outcome order-independent to assert). The Firestore emulator
 * variants are `todo` here: they need `npm run test:emulator`.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on d93a9a2b for the reason its criterion names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_AND_TRAVEL,
  assertChatConflict,
  assertEditInvalid,
  assertOneTurnPair,
  assertProposalConflict,
  beginRules,
  captureFootprint,
  chat,
  confirmRaw,
  edit,
  editOf,
  editRaw,
  end,
  itemById,
  itemWith,
  revisionOf,
  savedCommitments,
  seedWith,
  show,
} from './support.ts';

test('B1b revision: a fresh chat proposal is at revision 0, an edit answers revision 1 with the same proposalId and ids', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    assert.equal(first.proposal?.revision, 0, `a new proposal does not say revision 0 (got ${show(first.proposal?.revision)})`);
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const edited = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    assert.equal(edited.proposal!.revision, 1, 'the edit did not write revision 1');
    assert.equal(edited.proposal!.proposalId, first.proposal!.proposalId, 'the edit minted a new proposal');
    assert.equal(itemWith(edited.proposal, 'بأختي').itemId, call.itemId, 'the edited item lost its id');
    assert.equal(seedWith(edited.proposal, 'أسافر').seedItemId, travel.seedItemId, 'the untouched seed lost its id');
  } finally {
    end();
  }
});

test('B1b idempotency: an identical retry replays the same answer — no second turn, no new revision', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const spec = editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' });
    const applied = await edit(uid, first.conversationId, spec);
    assertOneTurnPair(first, applied, 'the first edit');
    const retried = await edit(uid, first.conversationId, spec);
    assert.equal(retried.proposal!.revision, applied.proposal!.revision, 'the retry wrote another revision');
    assert.equal(retried.turns.length, applied.turns.length, 'the retry recorded a second turn pair');
    assert.equal(retried.reply, applied.reply, 'the retry did not replay the same reply');
    assert.deepEqual(retried.proposal!.items, applied.proposal!.items, 'the retry did not replay the same items');
  } finally {
    end();
  }
});

test('B1b idempotency: a delayed retry of an older edit after a newer one → 409 with the newest answer', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const older = editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' });
    const one = await edit(uid, first.conversationId, older);
    const two = await edit(uid, first.conversationId, editOf(one, { itemId: call.itemId }, { text: 'اتصل بخالتي' }));
    const late = await editRaw(uid, first.conversationId, older);
    const current = assertChatConflict(late, 'the delayed retry of the first edit');
    assert.equal(current.proposal?.revision, two.proposal!.revision, 'the 409 is not at the newest revision');
    assert.equal(itemById(current.proposal, call.itemId).title, 'اتصل بخالتي', 'the delayed retry undid the newer edit');
    assert.equal(current.turns.length, two.turns.length, 'the delayed retry recorded a turn');
  } finally {
    end();
  }
});

test('B1b idempotency: a true no-op (kind already commitment, text already the title) → edit_invalid and no turn', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { kind: 'commitment' })), 'kind commitment on a commitment');
    assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: call.title })), 'the same title');
    assertEditInvalid(await editRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'consideration' })), 'the same seed kind');
    // Nothing was recorded by the no-ops: the next real edit is revision 1 and adds exactly one pair.
    const applied = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    assert.equal(applied.proposal!.revision, 1, 'a no-op wrote a revision');
    assertOneTurnPair(first, applied, 'the edit after the no-ops');
  } finally {
    end();
  }
});

test('B1b edit-vs-confirm (edit first): the confirm of the old revision saves nothing (409 open); the new revision saves the edited title once', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const edited = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const stale = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: 0 });
    const current = assertProposalConflict(stale, 'the confirm of revision 0', 'open');
    assert.equal(current.revision, edited.proposal!.revision);
    assert.deepEqual(await savedCommitments(uid), [], 'the stale confirm saved something');
    const ok = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: edited.proposal!.revision });
    assert.equal(ok.status, 200, `the confirm of the current revision answered ${ok.status}: ${show(ok.body)}`);
    const again = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: edited.proposal!.revision });
    assert.equal(again.status, 200, `the retried confirm answered ${again.status}: ${show(again.body)}`);
    assert.deepEqual((await savedCommitments(uid)).map((saved) => saved.title), ['اتصل بأختي'], 'not exactly the edited commitment, once');
  } finally {
    end();
  }
});

test('B1b edit-vs-confirm (confirm first): the edit gets 409 and the saved commitment is the confirmed revision\'s, once', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const confirmed = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: revisionOf(first.proposal) });
    assert.equal(confirmed.status, 200, `confirm answered ${confirmed.status}: ${show(confirmed.body)}`);
    assertChatConflict(await editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' })), 'the edit after the confirm');
    assert.deepEqual((await savedCommitments(uid)).map((saved) => saved.title), ['اتصل بأمي']);
  } finally {
    end();
  }
});

test('B1b edit-vs-confirm (concurrent, memory store): exactly one wins, nothing is saved twice or from a revision that was not confirmed', async () => {
  for (let round = 0; round < 3; round += 1) {
    const uid = beginRules();
    try {
      const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
      const call = itemWith(first.proposal, 'اتصل بأمي');
      const editing = () => editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
      const confirming = () => confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: 0 });
      // Started in either order: the edit first on even rounds, the confirm first on odd ones.
      const [edited, confirmed] = round % 2 === 0
        ? await Promise.all([editing(), confirming()])
        : (await Promise.all([confirming(), editing()])).reverse();
      const saved = (await savedCommitments(uid)).map((commitment) => commitment.title);
      if (confirmed.status === 200) {
        assertChatConflict(edited, `round ${round}: the edit racing a winning confirm`);
        assert.deepEqual(saved, ['اتصل بأمي'], `round ${round}: the confirm of revision 0 did not save revision 0, once`);
      } else {
        assert.equal(edited.status, 200, `round ${round}: neither the edit (${edited.status}: ${show(edited.body)}) nor the confirm (${confirmed.status}) won`);
        assertProposalConflict(confirmed, `round ${round}: the confirm racing a winning edit`, 'open');
        assert.deepEqual(saved, [], `round ${round}: a confirm of revision 0 saved after the edit moved the proposal on`);
      }
    } finally {
      end();
    }
  }
});

test('B1b edit-vs-edit (concurrent): two different edits on revision 0 → one 200, one 409; the proposal ends at revision 1', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const travel = seedWith(first.proposal, 'أسافر');
    const results = await Promise.all([
      editRaw(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' })),
      editRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { kind: 'idea' })),
    ]);
    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 409], `two edits on one revision answered ${show(results.map((result) => [result.status, result.body?.reason]))}`);
    const loser = results.find((result) => result.status === 409)!;
    assert.equal(assertChatConflict(loser, 'the losing edit').proposal?.revision, 1, 'the losing edit\'s 409 is not at revision 1');
  } finally {
    end();
  }
});

test('B1b duplicate edit (concurrent): the same edit twice at once → both 200 with one answer, revision 1, one turn pair', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const spec = editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' });
    const [a, b] = await Promise.all([editRaw(uid, first.conversationId, spec), editRaw(uid, first.conversationId, spec)]);
    assert.deepEqual([a.status, b.status], [200, 200], `a duplicated edit answered ${a.status}/${b.status}: ${show([a.body, b.body])}`);
    assert.equal(a.body.proposal.revision, 1);
    assert.equal(b.body.proposal.revision, 1, 'the duplicate wrote a second revision');
    assert.equal(a.body.turns.length, b.body.turns.length, 'the duplicate recorded another turn pair');
    assertOneTurnPair(first, b.body, 'the duplicated edit');
  } finally {
    end();
  }
});

test('B1b edit-vs-chat-message: a message after an edit moves the proposal on, so an edit on the pre-message proposal → 409 with the current answer', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const edited = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const message = await chat(uid, 'ولازم اشتري خبز بكرا الساعة 6 المسا', { conversationId: first.conversationId, locale: 'ar' });
    const late = await editRaw(uid, first.conversationId, editOf(edited, { itemId: call.itemId }, { text: 'اتصل بخالتي' }));
    const current = assertChatConflict(late, 'an edit on the proposal before the message');
    assert.equal(current.proposal?.proposalId, message.proposal?.proposalId, 'the 409 does not carry the proposal the message produced');
    assert.equal(current.proposal?.revision, revisionOf(message.proposal));
  } finally {
    end();
  }
});

test('B1b receipts bounded: forty edits leave the stored capture footprint no larger than after ten', async () => {
  const uid = beginRules();
  try {
    let answer = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(answer.proposal, 'اتصل بأمي');
    let after10: { documents: number; bytes: number } | null = null;
    for (let n = 1; n <= 40; n += 1) {
      // Same length every time, so only growth in what is kept shows.
      answer = await edit(uid, answer.conversationId, editOf(answer, { itemId: call.itemId }, { text: `اتصل بأمي ${String(n).padStart(2, '0')}` }));
      assert.equal(answer.proposal!.revision, n, `edit ${n} did not write revision ${n}`);
      if (n === 10) after10 = await captureFootprint(uid);
    }
    const after40 = await captureFootprint(uid);
    assert.equal(after40.documents, after10!.documents, `the capture documents grew from ${after10!.documents} to ${after40.documents}`);
    assert.ok(after40.bytes <= after10!.bytes + 512, `the stored capture grew from ${after10!.bytes} to ${after40.bytes} bytes over 30 more edits`);
  } finally {
    end();
  }
});

test.todo('B1b revision + edit receipt round trip through the Firestore adapter (a replay after a restart): emulator');
test.todo('B1b edit-vs-confirm, edit-vs-edit and duplicate edit with real transaction contention: emulator');
test.todo('B1b edit-vs-chat-message truly concurrent (both in flight on one conversation): emulator');

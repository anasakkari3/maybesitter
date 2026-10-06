/**
 * M2b Task B, criterion 3b (the v3 protocol, M2B-REV2-001..004) with the v4
 * dispositions (M2B-A-R3-001/003/004, M2B-REV3-001..003): clarification joins
 * the revision protocol (with a legacy path for a clarify with no revision);
 * confirm and capture-seed keep compare an optional `revision` in their own
 * transaction — absent only while the proposal is at revision 0 — and answer
 * 409 `{ reason, proposal, state, confirmation? }`; an exact confirm/keep retry
 * replays before any conflict; the capture's timezone is stored on the
 * proposal and used where a patch has no zone of its own (seed promotion).
 *
 * The correction-span half of 3b is in corrections.test.ts; the delayed old
 * retry in revisions.test.ts.
 *
 * Acceptance gate written independently of the builder: every test here must
 * fail on d93a9a2b for the reason its criterion names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_AND_TRAVEL,
  DOCTOR,
  DOCTOR_AND_TRAVEL,
  LATER,
  TOMORROW,
  TZ,
  assertChatConflict,
  assertProposalConflict,
  at,
  beginRules,
  chat,
  clarifyRaw,
  confirmRaw,
  edit,
  editOf,
  editRaw,
  end,
  itemById,
  itemWith,
  keepSeedRaw,
  keptSeeds,
  revisionOf,
  savedCommitments,
  seedById,
  seedWith,
  show,
  type Proposal,
} from './support.ts';

async function okProposal(result: { status: number; body: unknown }, label: string): Promise<Proposal> {
  assert.equal(result.status, 200, `${label} answered ${result.status}: ${show(result.body)}`);
  return result.body as Proposal;
}

/* ── clarify ──────────────────────────────────────────────────────── */

test('B3b clarify (legacy): a clarify with no revision at revision 0 still answers, and writes revision 1', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const answered = await okProposal(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }), 'the legacy clarify');
    assert.equal(itemById(answered, doctor.itemId).resolvedTime, at(TOMORROW, '16:00'));
    assert.equal(answered.revision, 1, `the legacy clarify did not write revision 1 (got ${show(answered.revision)})`);
  } finally {
    end();
  }
});

test('B3b clarify: after an edit, a clarify with the old revision or none → 409 { proposal, state: open }; with the current revision → answered at revision+1, the edit kept', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const travel = seedWith(first.proposal, 'أسافر');
    const edited = await edit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { text: 'أسافر عالبحر' }));
    const stale = assertProposalConflict(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }, { revision: 0 }), 'a clarify at revision 0', 'open');
    assert.equal(stale.revision, edited.proposal!.revision);
    assert.equal(itemById(stale, doctor.itemId).needsClarification, true, 'the refused clarify was applied');
    assertProposalConflict(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }), 'a clarify with no revision past revision 0', 'open');
    const answered = await okProposal(
      await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }, { revision: edited.proposal!.revision! }),
      'the clarify at the current revision',
    );
    assert.equal(answered.revision, edited.proposal!.revision! + 1, 'the clarify did not write revision+1');
    assert.equal(itemById(answered, doctor.itemId).resolvedTime, at(TOMORROW, '16:00'));
    assert.equal(seedById(answered, travel.seedItemId).summary, 'أسافر عالبحر', 'the clarify dropped the earlier edit');
  } finally {
    end();
  }
});

test('B3b edit-vs-clarify (clarify first): an edit on the pre-clarify revision → 409 with the clarified answer', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const travel = seedWith(first.proposal, 'أسافر');
    const answered = await okProposal(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }, { revision: 0 }), 'the clarify');
    const late = await editRaw(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { text: 'أسافر عالبحر' }));
    const current = assertChatConflict(late, 'an edit on the pre-clarify revision');
    assert.equal(current.proposal?.revision, answered.revision, 'the 409 is not at the clarified revision');
    assert.equal(itemById(current.proposal, doctor.itemId).needsClarification, false, 'the 409 answer is not the clarified one');
    assert.equal(seedById(current.proposal, travel.seedItemId).summary, travel.summary, 'the refused edit was applied');
  } finally {
    end();
  }
});

test('B3b clarify-vs-confirm (clarify first): the confirm of the pre-clarify revision saves nothing; the current revision saves the clarified time', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR_AND_TRAVEL, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    const answered = await okProposal(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }, { revision: 0 }), 'the clarify');
    const stale = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [doctor.itemId], revision: 0 });
    assertProposalConflict(stale, 'the confirm of revision 0', 'open');
    assert.deepEqual(await savedCommitments(uid), [], 'the stale confirm saved something');
    const ok = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [doctor.itemId], revision: answered.revision });
    assert.equal(ok.status, 200, `the confirm of the clarified revision answered ${ok.status}: ${show(ok.body)}`);
    const saved = await savedCommitments(uid);
    assert.deepEqual(saved.map((commitment) => commitment.timeSpec.dueAt), [at(TOMORROW, '16:00')]);
  } finally {
    end();
  }
});

test('B3b clarify-vs-confirm (confirm first): a clarify after the confirm → 409 state confirmed, and the saved commitment keeps the confirmed time', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, DOCTOR, { locale: 'ar' });
    const doctor = itemWith(first.proposal, 'الدكتور');
    // The person answered the question by hand in review (#164 manual completion) and confirmed.
    const confirmed = await confirmRaw(uid, {
      proposalId: first.proposal!.proposalId,
      itemIds: [doctor.itemId],
      revision: 0,
      edits: [{ itemId: doctor.itemId, title: doctor.title, resolvedTime: at(LATER, '16:00') }],
    });
    assert.equal(confirmed.status, 200, `confirm answered ${confirmed.status}: ${show(confirmed.body)}`);
    assertProposalConflict(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }, { revision: 0 }), 'a clarify after the confirm', 'confirmed');
    assertProposalConflict(await clarifyRaw(uid, first.proposal!, doctor, { optionId: 'pm' }), 'a legacy clarify after the confirm', 'confirmed');
    assert.deepEqual((await savedCommitments(uid)).map((commitment) => commitment.timeSpec.dueAt), [at(LATER, '16:00')]);
  } finally {
    end();
  }
});

/* ── confirm ──────────────────────────────────────────────────────── */

test('B3b confirm: no revision once the proposal is past revision 0 → 409 and nothing saved; at revision 0 no revision confirms as before', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    assertProposalConflict(await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [call.itemId] }), 'a confirm with no revision at revision 1', 'open');
    assert.deepEqual(await savedCommitments(uid), [], 'a confirm with no revision saved an edited proposal');

    const legacy = await chat(uid, 'لازم اشتري خبز بكرا الساعة 6 المسا', { locale: 'ar' });
    const bread = itemWith(legacy.proposal, 'خبز');
    const ok = await confirmRaw(uid, { proposalId: legacy.proposal!.proposalId, itemIds: [bread.itemId] });
    assert.equal(ok.status, 200, `a legacy confirm at revision 0 answered ${ok.status}: ${show(ok.body)}`);
  } finally {
    end();
  }
});

test('B3b confirm: an exact retry replays its success whatever the revision; a different intent on the confirmed proposal → 409 state confirmed', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const call = itemWith(first.proposal, 'اتصل بأمي');
    const edited = await edit(uid, first.conversationId, editOf(first, { itemId: call.itemId }, { text: 'اتصل بأختي' }));
    const body = { proposalId: first.proposal!.proposalId, itemIds: [call.itemId], revision: edited.proposal!.revision };
    const ok = await confirmRaw(uid, body);
    assert.equal(ok.status, 200, `the confirm answered ${ok.status}: ${show(ok.body)}`);
    for (const retry of [body, { ...body, revision: 0 }, { proposalId: body.proposalId, itemIds: body.itemIds }]) {
      const replay = await confirmRaw(uid, retry);
      assert.equal(replay.status, 200, `the exact retry ${show(retry)} answered ${replay.status}: ${show(replay.body)}`);
      assert.equal(replay.body.replayed, true, `the exact retry ${show(retry)} was not a replay`);
    }
    const other = await confirmRaw(uid, { ...body, edits: [{ itemId: call.itemId, title: 'اتصل بخالتي' }] });
    const current = assertProposalConflict(other, 'a different confirm on the confirmed proposal', 'confirmed');
    assert.equal(current.proposalId, first.proposal!.proposalId);
    assert.deepEqual((await savedCommitments(uid)).map((commitment) => commitment.title), ['اتصل بأختي'], 'not the confirmed commitment, once');
  } finally {
    end();
  }
});

/* ── capture-seed keep ────────────────────────────────────────────── */

test('B3b seed keep: a stale revision, or none past revision 0 → 409 and no seed; the current revision keeps the edited words; an exact retry replays; a legacy keep at revision 0 still keeps', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, CALL_AND_TRAVEL, { locale: 'ar' });
    const travel = seedWith(first.proposal, 'أسافر');
    const edited = await edit(uid, first.conversationId, editOf(first, { seedItemId: travel.seedItemId }, { text: 'أسافر عالبحر' }));
    const keep = { proposalId: first.proposal!.proposalId, seedItemId: travel.seedItemId };
    const stale = assertProposalConflict(await keepSeedRaw(uid, { ...keep, revision: 0 }), 'a keep at revision 0', 'open');
    assert.equal(seedById(stale, travel.seedItemId).summary, 'أسافر عالبحر', 'the 409 does not carry the current proposal');
    assertProposalConflict(await keepSeedRaw(uid, keep), 'a keep with no revision past revision 0', 'open');
    assert.deepEqual(await keptSeeds(uid), [], 'a refused keep kept a seed');

    const kept = await keepSeedRaw(uid, { ...keep, revision: edited.proposal!.revision });
    assert.equal(kept.status, 201, `the keep at the current revision answered ${kept.status}: ${show(kept.body)}`);
    assert.equal(kept.body.seed.summary, 'أسافر عالبحر', 'the kept seed is not the edited words');
    const replay = await keepSeedRaw(uid, { ...keep, revision: edited.proposal!.revision });
    assert.equal(replay.status, 200, `the exact keep retry answered ${replay.status}: ${show(replay.body)}`);
    assert.equal((await keptSeeds(uid)).length, 1, 'the retry kept a second seed');

    const legacy = await chat(uid, 'حلو لو نعمل رحلة للبحر', { locale: 'ar' });
    const idea = seedWith(legacy.proposal, 'رحلة');
    const legacyKeep = await keepSeedRaw(uid, { proposalId: legacy.proposal!.proposalId, seedItemId: idea.seedItemId });
    assert.equal(legacyKeep.status, 201, `a legacy keep at revision 0 answered ${legacyKeep.status}: ${show(legacyKeep.body)}`);
  } finally {
    end();
  }
});

/* ── the proposal's timezone ──────────────────────────────────────── */

test('B3b timezone: an undated item given a time is stored in the item\'s own zone, not the edit request\'s envelope zone', async () => {
  const uid = beginRules();
  try {
    const first = await chat(uid, 'لازم اشتري خبز', { locale: 'ar', timezone: TZ });
    const bread = itemWith(first.proposal, 'خبز');
    assert.equal(bread.resolvedTime, null);
    // 23:30Z on the 10th is 01:30 on the 11th in Jerusalem; in UTC it is still the 10th.
    const instant = '2030-01-10T23:30:00.000Z';
    const set = await edit(uid, first.conversationId, editOf(first, { itemId: bread.itemId }, { time: { at: instant, timeZone: TZ } }), { timezone: 'UTC' });
    const item = itemById(set.proposal, bread.itemId);
    assert.equal(item.resolvedTime, instant);
    assert.equal(item.resolvedDate, '2030-01-11', `the day was read on the request's clock, not the item's: ${item.resolvedDate}`);
    const ok = await confirmRaw(uid, { proposalId: first.proposal!.proposalId, itemIds: [bread.itemId], revision: set.proposal!.revision });
    assert.equal(ok.status, 200, `the confirm answered ${ok.status}: ${show(ok.body)}`);
    const saved = await savedCommitments(uid);
    assert.equal(saved[0]?.timeSpec.dueAt, instant);
    assert.equal(saved[0]?.timeSpec.timezone, TZ, 'the saved commitment is not in the item\'s zone');
  } finally {
    end();
  }
});

test('B3b timezone: a seed made a commitment with no time asks on the proposal\'s own clock (New York), not the edit request\'s (Tokyo)', async () => {
  // 20:00Z: 16:00 on the 7th in New York, 05:00 on the 8th in Tokyo — the
  // evening option falls on a different day in each.
  const referenceTime = '2026-10-07T20:00:00.000Z';
  const uid = beginRules();
  try {
    const control = await chat(uid, 'لازم نعمل رحلة للبحر', { locale: 'ar', timezone: 'America/New_York', referenceTime });
    const expected = itemWith(control.proposal, 'رحلة').clarification?.options.map((option) => [option.optionId, option.value ?? null]);
    assert.ok(expected?.length, 'the control asks nothing');

    const first = await chat(uid, 'حلو لو نعمل رحلة للبحر', { locale: 'ar', timezone: 'America/New_York', referenceTime });
    const idea = seedWith(first.proposal, 'رحلة');
    const promoted = await edit(
      uid,
      first.conversationId,
      editOf(first, { seedItemId: idea.seedItemId }, { kind: 'commitment' }),
      { timezone: 'Asia/Tokyo', referenceTime },
    );
    const item = itemById(promoted.proposal, idea.seedItemId);
    assert.equal(item.needsClarification, true, 'the promoted seed does not ask the time');
    const options = item.clarification?.options.map((option) => [option.optionId, option.value ?? null]);
    assert.deepEqual(options, expected, 'the promoted seed\'s time question was built on the request\'s clock, not the proposal\'s');
  } finally {
    end();
  }
});

test.todo('B3b edit-vs-clarify and clarify-vs-confirm, both orders, through the Firestore adapter: emulator');
test.todo('B3b the proposal timezone and the correction spans survive the Firestore proposal serializer: emulator');
test.todo('B3b seed-keep receipt (proposal + seed + base revision) round trip through Firestore: emulator');

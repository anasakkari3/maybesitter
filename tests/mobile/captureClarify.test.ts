import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { proposeMobileCapture, clarifyMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { createStorageCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore.ts';
import { ClarifyError } from '../../lib/services/captureBoundary/clarifyService.ts';

/**
 * Answering the one question (UC-2.5, #165).
 *
 * ── The assertion that matters is about the command ──────────────
 *
 * A `resolvedTime` patched onto the proposal would look right on the review
 * screen and leave the *command* — what a confirm actually persists — holding
 * the old time. Somebody answering "nine in the evening" would then get a
 * commitment at nine in the morning. So these check what the store holds after
 * the answer, not only what comes back.
 */

const UID = 'ClarifyUser';
const ZONE = 'Asia/Jerusalem';
const NOW = '2026-09-13T06:00:00.000Z'; // 09:00 local

function setup() {
  setStorageForTests(createMemoryStorage());
  return () => resetStorageForTests();
}

/**
 * A capture with an action and no time: `decideExtractionDisposition` returns
 * `needs_clarification`, and the builder asks `ask_time`.
 */
async function proposeAmbiguous(text = 'Remind me to call Dana') {
  const proposal = await proposeMobileCapture(
    { text, timezone: ZONE, referenceTime: NOW },
    { participantId: UID },
  );
  const item = proposal.items.find((candidate) => candidate.needsClarification && candidate.clarification);
  return { proposal, item };
}

test('a capture the extractor cannot pin down carries one question, in keys not prose', async () => {
  const cleanup = setup();
  try {
    const { item } = await proposeAmbiguous();
    assert.ok(item, 'expected an item needing clarification');
    const question = item.clarification!;
    assert.match(question.questionKey, /^[a-z_]+$/);
    for (const option of question.options) {
      // Keys only. A sentence here would be a sentence the phone cannot
      // translate and nobody reviewed.
      assert.match(option.labelKey, /^[a-zA-Z][a-zA-Z0-9_]*$/);
    }
  } finally {
    cleanup();
  }
});

test('choosing an option moves the command, not just the displayed time', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const question = item.clarification!;
    const option = question.options.find((candidate) => candidate.value.localTime) ?? question.options[0]!;

    const updated = await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: option.optionId, timezone: ZONE, referenceTime: NOW },
      { participantId: UID },
    );

    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.equal(answered.needsClarification, false);
    assert.equal(answered.clarification, null);

    // The command is what a confirm persists. If the answer stopped at the
    // contract, this is empty and the review screen is lying.
    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    const commands = stored?.commandsByItemId.get(item.itemId) ?? [];
    assert.ok(commands.length > 0, 'expected the command to be rebuilt from the answer');

    // And it is the hour they chose, on the date the option named. A meridiem
    // read wrongly here is a twelve-hour error on somebody's commitment, which
    // is the whole reason the question is asked instead of guessed (#162).
    const expected = new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONE, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(answered.resolvedTime!));
    assert.equal(expected, option.value.localTime);
    const expectedDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date(answered.resolvedTime!));
    assert.equal(expectedDay, option.value.localDate);
  } finally {
    cleanup();
  }
});

test('the same item cannot be asked twice', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const question = item.clarification!;
    const body = {
      proposalId: proposal.proposalId, itemId: item.itemId,
      questionId: question.questionId, optionId: question.options[0]!.optionId,
      timezone: ZONE, referenceTime: NOW,
    };
    await clarifyMobileCapture(body, { participantId: UID });
    // A product that asks twice has stopped being a capture box.
    await assert.rejects(
      () => clarifyMobileCapture(body, { participantId: UID }),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'already_clarified',
    );
  } finally {
    cleanup();
  }
});

test('an answer to a question this proposal is not asking is refused', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    await assert.rejects(
      () => clarifyMobileCapture(
        { proposalId: proposal.proposalId, itemId: item.itemId, questionId: 'some-other-question', optionId: 'x', timezone: ZONE, referenceTime: NOW },
        { participantId: UID },
      ),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'question_mismatch',
    );
  } finally {
    cleanup();
  }
});

test('another account cannot answer this proposal', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    // The scope is the token's uid. Answering applies a change to somebody's
    // commitment, so this is the same rule the confirm follows.
    await assert.rejects(
      () => clarifyMobileCapture(
        { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: item.clarification!.options[0]!.optionId, timezone: ZONE, referenceTime: NOW },
        { participantId: 'SomebodyElse' },
      ),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'proposal_not_found',
    );
  } finally {
    cleanup();
  }
});

test('an empty answer is refused, and an over-long one too', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const base = {
      proposalId: proposal.proposalId, itemId: item.itemId,
      questionId: item.clarification!.questionId, timezone: ZONE, referenceTime: NOW,
    };
    await assert.rejects(
      () => clarifyMobileCapture(base, { participantId: UID }),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'answer_required',
    );
    await assert.rejects(
      () => clarifyMobileCapture({ ...base, freeText: 'x'.repeat(201) }, { participantId: UID }),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'free_text_too_long',
    );
  } finally {
    cleanup();
  }
});

test('free text is re-read by the extractor, not spliced into the title', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const updated = await clarifyMobileCapture(
      {
        proposalId: proposal.proposalId, itemId: item.itemId,
        questionId: item.clarification!.questionId,
        freeText: 'بالمسا',
        timezone: ZONE, referenceTime: NOW,
      },
      { participantId: UID },
    );
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    // The words the user added are not the title. Splicing them in would also
    // skip the injection screen, which only the extractor runs.
    assert.ok(!answered.title.includes('بالمسا'));
  } finally {
    cleanup();
  }
});

test('an unknown option is refused rather than silently ignored', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    await assert.rejects(
      () => clarifyMobileCapture(
        { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, optionId: 'not-an-option', timezone: ZONE, referenceTime: NOW },
        { participantId: UID },
      ),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'option_not_found',
    );
  } finally {
    cleanup();
  }
});

test('what the durable store keeps survives the round trip', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);

    // Read back through the storage adapter, which is what production uses.
    // `StoredCaptureProposal` carries three things a JSON document cannot hold
    // by itself — two Maps and, before this, `proposedAt`.
    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    assert.ok(stored, 'expected the proposal to be readable');

    // `proposedAt` was written into the in-memory shape and never into the
    // document, so on the durable store it was always undefined and #164's
    // thirty-minute staleness guard could never fire. The Map-backed store the
    // other tests use kept it, which is why nothing failed.
    assert.equal(typeof stored.proposedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(stored.proposedAt!)));

    assert.ok(stored.resultsByItemId?.get(item.itemId), 'expected the extraction to survive');
    assert.ok(stored.commandsByItemId instanceof Map);
  } finally {
    cleanup();
  }
});

test('a proposal older than the TTL is refused by the durable store too', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const store = createStorageCaptureProposalStore();
    const stored = (await store.get(proposal.proposalId))!;
    // Thirty-one minutes ago.
    await store.put({ ...stored, proposedAt: new Date(Date.parse(NOW) - 31 * 60 * 1000).toISOString() });

    const { confirmMobileCapture } = await import('../../lib/services/mobile/mobileCaptureService.ts');
    const result = await confirmMobileCapture(
      { proposalId: proposal.proposalId, scopeId: UID, itemIds: [item.itemId], idempotencyKey: 'k1' },
      { participantId: UID },
    );
    assert.equal(result.success, false);
    assert.equal(result.failureCode, 'proposal_not_found');
  } finally {
    cleanup();
  }
});

/**
 * "No specific time" is an answer, and it settles the item (#474).
 *
 * The builder always offers it — a commitment without an hour is a legitimate
 * thing to want — but answering with it used to leave the extraction unchanged,
 * so the item came back still flagged, with no command, and could never be
 * confirmed. The review screen then had nothing to save and no way out.
 */
async function answerNoTime() {
  const { proposal, item } = await proposeAmbiguous();
  assert.ok(item, 'expected an item needing clarification');
  const question = item.clarification!;
  const none = question.options.find((option) => !option.value.localTime && !option.value.localDate);
  assert.ok(none, `expected a no-time option, got ${question.options.map((option) => option.optionId).join(',')}`);
  const updated = await clarifyMobileCapture(
    { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: none.optionId, timezone: ZONE, referenceTime: NOW },
    { participantId: UID },
  );
  return { proposal, item, updated };
}

test('answering "no specific time" settles the item as a time-less commitment', async () => {
  const cleanup = setup();
  try {
    const { proposal, item, updated } = await answerNoTime();
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.equal(answered.needsClarification, false);
    assert.equal(answered.resolvedTime, null);
    assert.equal(answered.clarification, null);
    assert.equal(updated.status, 'proposed');

    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    const commands = stored?.commandsByItemId.get(item.itemId) ?? [];
    const draft = commands.find((command) => command.type === 'CreateDraft') as
      | { draftStatus?: string; commitment: { timeSpec: { kind: string; dueAt: string | null; remindAt: string | null } } }
      | undefined;
    assert.ok(draft, 'expected a draft the confirm can persist');
    assert.equal(draft.commitment.timeSpec.kind, 'unscheduled');
    assert.equal(draft.commitment.timeSpec.dueAt, null);
    assert.equal(draft.commitment.timeSpec.remindAt, null);
    assert.equal(draft.draftStatus, 'pending_confirmation');
    // No reminder is scheduled for a commitment with no time.
    assert.ok(!commands.some((command) => command.type === 'ConfirmCommitment'));
  } finally {
    cleanup();
  }
});

test('an item answered with "no specific time" is persisted and active on confirm', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await answerNoTime();
    const { confirmMobileCapture } = await import('../../lib/services/mobile/mobileCaptureService.ts');
    const { getParticipantStateSnapshot } = await import('../../lib/services/mobile/participantState.ts');
    const result = await confirmMobileCapture(
      { proposalId: proposal.proposalId, itemIds: [item.itemId], idempotencyKey: 'k-none' },
      { participantId: UID },
    );
    assert.equal(result.success, true, `failed with ${result.failureCode}`);
    assert.equal(result.persisted.length, 1);
    assert.equal(result.persisted[0]!.itemId, item.itemId);
    assert.equal(result.persisted[0]!.resolvedTime, null);

    const commitment = (await getParticipantStateSnapshot(UID)).commitments[result.persisted[0]!.commitmentId];
    assert.ok(commitment, 'expected the commitment in the user\'s own state');
    assert.equal(commitment.status, 'active');
    assert.equal(commitment.timeSpec.kind, 'unscheduled');
  } finally {
    cleanup();
  }
});

test('a timed option still resolves a time after the no-time change', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const question = item.clarification!;
    const timed = question.options.find((option) => option.value.localTime)!;
    const updated = await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: timed.optionId, timezone: ZONE, referenceTime: NOW },
      { participantId: UID },
    );
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.ok(answered.resolvedTime, 'a timed answer must keep its time');
  } finally {
    cleanup();
  }
});

/**
 * The dead end the owner hit on the first iPhone run: every question answered,
 * and still nothing could be saved.
 *
 * An item the extractor flagged for *low confidence* (below the policy's 0.6
 * floor, kept only because the user asked to be reminded) was asked when, was
 * told when, and came back still flagged — `needsClarification: true` with
 * `clarification: null` and no command — because an answer set the time and
 * left the confidence where the extractor had put it. The one allowed round was
 * spent, so there was no second question either; the confirm refused it with
 * `invalid_selection`. A user's explicit answer to the question that was asked
 * settles that question.
 */
async function confirmAnswered(proposalId: string, itemId: string) {
  const { confirmMobileCapture } = await import('../../lib/services/mobile/mobileCaptureService.ts');
  const { getParticipantStateSnapshot } = await import('../../lib/services/mobile/participantState.ts');
  const result = await confirmMobileCapture(
    { proposalId, itemIds: [itemId], idempotencyKey: `k-${itemId}` },
    { participantId: UID },
  );
  const commitmentId = result.persisted[0]?.commitmentId;
  const commitment = commitmentId ? (await getParticipantStateSnapshot(UID)).commitments[commitmentId] : undefined;
  return { result, commitment };
}

for (const text of ['Remind me to maybe call Dana', 'ذكرني يمكن اتصل بدانا', 'remind me to call Dana and email Sam']) {
  test(`a low-confidence reminder answered with an option can be saved: «${text}»`, async () => {
    const cleanup = setup();
    try {
      const { proposal, item } = await proposeAmbiguous(text);
      assert.ok(item, 'expected an item carrying a question');
      const question = item.clarification!;
      const evening = question.options.find((option) => option.optionId === 'evening') ?? question.options.find((option) => option.value.localTime)!;

      const updated = await clarifyMobileCapture(
        { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: evening.optionId, timezone: ZONE, referenceTime: NOW },
        { participantId: UID },
      );
      const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
      assert.equal(answered.needsClarification, false, 'the answered question did not settle the item');
      assert.ok(answered.resolvedTime, 'the chosen time is not on the item');
      assert.equal(updated.status, 'proposed');

      const { result, commitment } = await confirmAnswered(proposal.proposalId, item.itemId);
      assert.equal(result.success, true, `confirm failed with ${result.failureCode}`);
      assert.equal(result.persisted.length, 1);
      assert.ok(commitment, 'no commitment exists after a successful confirm');
      assert.equal(commitment.status, 'active');
      assert.equal(commitment.timeSpec.remindAt ?? commitment.timeSpec.dueAt, answered.resolvedTime);
    } finally {
      cleanup();
    }
  });
}

/**
 * The free-text path, literally: a capture with no "remind me" in it, answered
 * with words the rules alone read as a note. The item used to come back
 * *resolved* — `needsClarification: false` — holding zero commands, so the
 * review screen offered a Confirm the server then refused.
 */
test('a free-text answer the rules read as a note still leaves a commitment that can be saved', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous('Call Dana');
    assert.ok(item, 'expected an item carrying a question');
    const updated = await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: 'maybe in the evening', timezone: ZONE, referenceTime: NOW },
      { participantId: UID },
    );
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.equal(answered.needsClarification, false);
    assert.ok(answered.resolvedTime, 'an evening answer resolved no time');
    // The answer was about *when*. The title the user saw is the one they keep.
    assert.equal(answered.title, item.title);

    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    assert.ok((stored?.commandsByItemId.get(item.itemId) ?? []).length > 0, 'resolved with zero commands');

    const { result, commitment } = await confirmAnswered(proposal.proposalId, item.itemId);
    assert.equal(result.success, true, `confirm failed with ${result.failureCode}`);
    assert.ok(commitment);
    assert.equal(commitment.title, item.title);
  } finally {
    cleanup();
  }
});

test('a typed time moves the time and leaves the title the user saw', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const updated = await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: 'maybe later at 9pm', timezone: ZONE, referenceTime: NOW },
      { participantId: UID },
    );
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    // Re-read together, "Remind me to call Dana / maybe later at 9pm" comes back
    // titled "call Dana maybe later". The question was when, not what.
    assert.equal(answered.title, item.title);
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hour12: false }).format(new Date(answered.resolvedTime!));
    assert.equal(hour, '21');
  } finally {
    cleanup();
  }
});

test('a free-text part of the day answers a time question in Arabic', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const updated = await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, freeText: 'بالمسا', timezone: ZONE, referenceTime: NOW },
      { participantId: UID },
    );
    const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.equal(answered.needsClarification, false);
    assert.equal(answered.title, item.title, 'the answer leaked into the title');
    const hour = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', hour12: false }).format(new Date(answered.resolvedTime!));
    assert.equal(hour, '18');
    const { result } = await confirmAnswered(proposal.proposalId, item.itemId);
    assert.equal(result.success, true, `confirm failed with ${result.failureCode}`);
  } finally {
    cleanup();
  }
});

/**
 * An answer nothing can be read out of does not spend the round. The question
 * stays, so the app can say "didn't get that" and the person can tap an
 * option — rather than an item that is flagged, has no question and no way to
 * be saved.
 */
test('an answer that says nothing about the question keeps the question and the round', async () => {
  const cleanup = setup();
  try {
    const { proposal, item } = await proposeAmbiguous();
    assert.ok(item);
    const question = item.clarification!;
    await assert.rejects(
      () => clarifyMobileCapture(
        { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, freeText: 'hello', timezone: ZONE, referenceTime: NOW },
        { participantId: UID },
      ),
      (error: unknown) => error instanceof ClarifyError && error.failure === 'answer_not_understood',
    );
    const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
    const still = stored!.contract.items.find((candidate) => candidate.itemId === item.itemId)!;
    assert.equal(still.clarification?.questionId, question.questionId, 'the question was taken away');

    const option = question.options.find((candidate) => candidate.value.localTime)!;
    const updated = await clarifyMobileCapture(
      { proposalId: proposal.proposalId, itemId: item.itemId, questionId: question.questionId, optionId: option.optionId, timezone: ZONE, referenceTime: NOW },
      { participantId: UID },
    );
    assert.equal(updated.items.find((candidate) => candidate.itemId === item.itemId)!.needsClarification, false);
  } finally {
    cleanup();
  }
});

/**
 * The invariant, over every answer shape: after a round that was accepted, an
 * item is confirmable with commands. `needsClarification: true` beside
 * `clarification: null` is the dead end, and no accepted answer may produce it.
 */
test('no accepted answer leaves an item flagged with no question and no command', async () => {
  const cleanup = setup();
  try {
    const cases: Array<[string, { optionId?: string; freeText?: string }]> = [
      ['Remind me to maybe call Dana', { optionId: 'morning' }],
      ['Remind me to maybe call Dana', { optionId: 'none' }],
      ['Remind me to maybe call Dana', { freeText: 'at 9pm' }],
      ['Remind me to call Dana', { freeText: 'tomorrow at 6pm' }],
      ['Call Dana', { freeText: 'maybe in the evening' }],
      ['ذكرني يمكن اتصل بدانا', { freeText: 'الساعة 8 المسا' }],
      ['follow up with Sam', { optionId: 'afternoon' }],
    ];
    for (const [text, answer] of cases) {
      const { proposal, item } = await proposeAmbiguous(text);
      assert.ok(item, `no question for «${text}»`);
      const updated = await clarifyMobileCapture(
        { proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification!.questionId, ...answer, timezone: ZONE, referenceTime: NOW },
        { participantId: UID },
      );
      const answered = updated.items.find((candidate) => candidate.itemId === item.itemId)!;
      assert.equal(answered.needsClarification, false, `«${text}» + ${JSON.stringify(answer)} stayed flagged`);
      const stored = await createStorageCaptureProposalStore().get(proposal.proposalId);
      assert.ok((stored?.commandsByItemId.get(item.itemId) ?? []).length > 0, `«${text}» + ${JSON.stringify(answer)} has no command`);
      const { result } = await confirmAnswered(proposal.proposalId, item.itemId);
      assert.equal(result.success, true, `«${text}» + ${JSON.stringify(answer)} failed to confirm: ${result.failureCode}`);
    }
  } finally {
    cleanup();
  }
});

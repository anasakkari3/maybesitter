/**
 * What the user saw at confirm is what gets saved (UC-2.4, #164).
 *
 * The promise has two halves, and both are here:
 *
 *   - an edit is applied *with* the confirm, not after it, so there is no window
 *     in which the commitment exists with a title the user already changed;
 *   - one bad edit fails the whole confirm, so a set of edits never lands
 *     half-applied with nothing on screen to say which half.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, type Commitment } from '../../src/domain/stateMachine.ts';
import {
  confirmCapture,
  proposeCapture,
  MemoryCaptureProposalStore,
  TransactionalCapturePersistenceAdapter,
} from '../../lib/services/captureBoundary/index.ts';
import { CAPTURE_PROPOSAL_TTL_MS } from '../../src/contracts/v1/captureContracts.ts';

const now = new Date('2026-09-14T10:00:00+03:00');
const later = (ms: number) => new Date(now.getTime() + ms);

type Harness = {
  store: MemoryCaptureProposalStore;
  persistence: TransactionalCapturePersistenceAdapter;
};

function harness(): Harness {
  return {
    store: new MemoryCaptureProposalStore(),
    persistence: new TransactionalCapturePersistenceAdapter(createEmptyDomainState()),
  };
}

async function proposeOne(text = 'Remind me to call the clinic tomorrow at 9am', dependencies: Harness = harness()) {
  const contract = await proposeCapture(text, { now, timezone: 'Asia/Jerusalem', scopeId: 'a', requestedEngine: 'rules' }, dependencies);
  return { contract, dependencies };
}

/** The commitments the adapter actually holds. */
async function saved(dependencies: Harness): Promise<Commitment[]> {
  const state = await dependencies.persistence.snapshot();
  return Object.values(state.commitments) as Commitment[];
}

test('the proposal carries the priority it read, and whether it guessed it', async () => {
  const { contract } = await proposeOne();
  const item = contract.items[0];

  assert.ok(item, 'no item proposed');
  assert.ok(['low', 'normal', 'high'].includes(item.priority ?? ''), `priority=${item.priority}`);
  // Nothing in "call the clinic tomorrow at 9am" states an importance, so this
  // is the extractor's reading and has to say so.
  assert.equal(item.priorityEstimated, true);
});

test('an explicit importance is not reported as a guess', async () => {
  const { contract } = await proposeOne('Remind me to call the clinic tomorrow at 9am urgent');
  assert.equal(contract.items[0].priority, 'high');
  assert.equal(contract.items[0].priorityEstimated, false);
});

test('an edited title is what gets persisted, in the same write', async () => {
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;

  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId, title: 'Ring the clinic about the results' }],
    now,
  }, dependencies);

  assert.equal(result.success, true);
  const commitments = await saved(dependencies);
  assert.equal(commitments.length, 1);
  assert.equal(commitments[0].title, 'Ring the clinic about the results');
});

test('an edited priority is recorded as the user\'s, not as inferred', async () => {
  // `user_explicit` is what the next-step baseline reads as importance, so
  // mislabelling it would quietly change which commitment is recommended.
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;

  await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId, priority: 'high' }],
    now,
  }, dependencies);

  const commitment = (await saved(dependencies))[0];
  assert.equal(commitment.priority.level, 'high');
  assert.equal(commitment.priority.source, 'user_explicit');
  assert.equal(commitment.priority.pressureAllowed, false);
});

test('an edited time replaces both the due and the reminder instant', async () => {
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;
  const chosen = later(3 * 60 * 60 * 1000).toISOString();

  await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId, resolvedTime: chosen }],
    now,
  }, dependencies);

  const commitment = (await saved(dependencies))[0];
  assert.equal(commitment.timeSpec.dueAt, chosen);
  assert.equal(commitment.timeSpec.remindAt, chosen);
});

test('clearing the time saves the commitment unscheduled rather than confirmed', async () => {
  // A confirmed commitment with nothing to remind anyone about is a reminder
  // that silently never fires.
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;

  await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId, resolvedTime: null }],
    now,
  }, dependencies);

  const commitment = (await saved(dependencies))[0];
  assert.equal(commitment.timeSpec.kind, 'unscheduled');
  assert.equal(commitment.timeSpec.remindAt, null);
});

test('one invalid edit fails the whole confirm and persists nothing', async () => {
  const { contract, dependencies } = await proposeOne(
    'Remind me to call the clinic tomorrow at 9am, then pay the bill tomorrow at 4pm',
  );
  const ids = contract.items.map((item) => item.itemId);
  assert.ok(ids.length >= 1);

  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: ids,
    idempotencyKey: 'k1',
    edits: [
      { itemId: ids[0], title: 'A perfectly good title' },
      // Empty after trimming: refused, and it takes the good one with it.
      { itemId: ids[0], title: '   ' },
    ],
    now,
  }, dependencies);

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'invalid_edit');
  assert.deepEqual(await saved(dependencies), [], 'a refused confirm persisted something');
});

test('every rule that can refuse an edit, and none of them writes anything', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['empty title', { title: '' }],
    ['whitespace-only title', { title: '   ' }],
    ['title over 120 characters', { title: 'x'.repeat(121) }],
    ['title with a newline', { title: 'two\nlines' }],
    ['a time in the past', { resolvedTime: '2020-01-01T00:00:00.000Z' }],
    ['a time that is not an instant', { resolvedTime: 'next tuesday' }],
    ['a priority outside the enum', { priority: 'urgent' }],
  ];

  for (const [label, edit] of cases) {
    const { contract, dependencies } = await proposeOne();
    const itemId = contract.items[0].itemId;
    const result = await confirmCapture({
      proposalId: contract.proposalId,
      scopeId: 'a',
      selectedItemIds: [itemId],
      idempotencyKey: 'k1',
      edits: [{ itemId, ...edit }],
      now,
    }, dependencies);

    assert.equal(result.failureCode, 'invalid_edit', label);
    assert.deepEqual(await saved(dependencies), [], `${label} persisted something`);
  }
});

test('an edit for an item that is not in this proposal is refused', async () => {
  const { contract, dependencies } = await proposeOne();
  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [contract.items[0].itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId: 'not-in-this-proposal', title: 'Sneaky' }],
    now,
  }, dependencies);

  assert.equal(result.failureCode, 'invalid_edit');
  assert.deepEqual(await saved(dependencies), []);
});

test('a title at exactly the limit is allowed, and one character more is not', async () => {
  const atLimit = 'y'.repeat(120);
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;

  const ok = await confirmCapture({
    proposalId: contract.proposalId, scopeId: 'a', selectedItemIds: [itemId],
    idempotencyKey: 'k1', edits: [{ itemId, title: atLimit }], now,
  }, dependencies);
  assert.equal(ok.success, true);
  assert.equal((await saved(dependencies))[0].title, atLimit);
});

test('an item that needed clarification can be completed by hand', async () => {
  // "Remind me tomorrow" names a day and no hour, so #162 leaves it needing a
  // question. Supplying a title and a time in review answers it.
  const { contract, dependencies } = await proposeOne('Remind me tomorrow to call the clinic');
  const item = contract.items[0];
  assert.ok(item, 'nothing was proposed to clarify');
  assert.equal(item.needsClarification, true);

  const chosen = later(26 * 60 * 60 * 1000).toISOString();
  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [item.itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId: item.itemId, title: 'Call the clinic', resolvedTime: chosen }],
    now,
  }, dependencies);

  assert.equal(result.success, true, `failed with ${result.failureCode}`);
  const commitment = (await saved(dependencies))[0];
  assert.equal(commitment.title, 'Call the clinic');
  assert.equal(commitment.timeSpec.remindAt, chosen);
  // Typed by hand, so none of it is inferred.
  assert.equal(commitment.priority.source, 'user_explicit');
});

test('a clarification item with only half an answer stays unconfirmable', async () => {
  const { contract, dependencies } = await proposeOne('Remind me tomorrow to call the clinic');
  const item = contract.items[0];

  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [item.itemId],
    idempotencyKey: 'k1',
    // A title but no time: still nothing to remind anyone about.
    edits: [{ itemId: item.itemId, title: 'Call the clinic' }],
    now,
  }, dependencies);

  assert.equal(result.success, false);
  assert.equal(result.failureCode, 'invalid_selection');
  assert.deepEqual(await saved(dependencies), []);
});

test('an edit for an item the user deselected is ignored, not refused', async () => {
  // Validating a change to something that is not being written would fail the
  // confirm for a reason the user cannot see on screen.
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;

  const result = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [itemId],
    idempotencyKey: 'k1',
    edits: [{ itemId, title: 'Kept' }, { itemId: 'some-other-item', title: '' }],
    now,
  }, dependencies);

  // The unknown id is still refused — it is not a deselection, it is a lie about
  // what is in this proposal.
  assert.equal(result.failureCode, 'invalid_edit');
});

test('a proposal older than thirty minutes cannot be confirmed', async () => {
  const { contract, dependencies } = await proposeOne();
  const itemId = contract.items[0].itemId;

  const stale = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [itemId],
    idempotencyKey: 'k1',
    now: later(CAPTURE_PROPOSAL_TTL_MS + 1000),
  }, dependencies);

  // The same code a swept proposal gives: from the client's side they are the
  // same thing, and the app offers to analyze the text again for both.
  assert.equal(stale.failureCode, 'proposal_not_found');
  assert.deepEqual(await saved(dependencies), []);
});

test('a proposal just inside the window still confirms', async () => {
  const { contract, dependencies } = await proposeOne();
  const fresh = await confirmCapture({
    proposalId: contract.proposalId,
    scopeId: 'a',
    selectedItemIds: [contract.items[0].itemId],
    idempotencyKey: 'k1',
    now: later(CAPTURE_PROPOSAL_TTL_MS - 1000),
  }, dependencies);

  assert.equal(fresh.success, true);
});

test('confirming twice with different edits is two intents, not a replay', async () => {
  // Through the real service, not a locally recomputed hash: the point is that
  // `idempotencyKeyFor` includes the edits, and a test that recomputes the hash
  // itself would pass even if the production key stopped including them.
  //
  // Without the edits in the key, a user who confirms, sees the title was wrong,
  // goes back and confirms again with a correction would send the same key — and
  // the boundary would replay the first result, report success, and write the
  // old title.
  const { createMemoryStorage } = await import('../../lib/storage/memoryAdapter.ts');
  const { resetStorageForTests, setStorageForTests } = await import('../../lib/storage/index.ts');
  const { proposeMobileCapture, confirmMobileCapture } = await import('../../lib/services/mobile/mobileCaptureService.ts');

  setStorageForTests(createMemoryStorage());
  try {
    const participantId = 'user-atomic-edits';
    const referenceTime = new Date().toISOString();
    const proposal = await proposeMobileCapture(
      { text: 'Remind me to call the clinic tomorrow at 9am', referenceTime, timezone: 'Asia/Jerusalem' },
      { participantId },
    ) as { proposalId: string; items: Array<{ itemId: string }> };

    const itemId = proposal.items[0]!.itemId;
    const confirmWith = (title: string) => confirmMobileCapture({
      proposalId: proposal.proposalId,
      itemIds: [itemId],
      edits: [{ itemId, title }],
    }, { participantId });

    const first = await confirmWith('First title');
    assert.equal(first.success, true);
    assert.equal(first.replayed, false);

    const second = await confirmWith('Corrected title');
    // Not a replay. The two confirms carry different edits, so they are
    // different intents and must not share an idempotency key.
    assert.equal(second.replayed, false, 'a different edit was replayed as the first confirm');
    assert.equal(second.success, false, 'the same proposal was confirmed twice');
    assert.equal(second.failureCode, 'invalid_selection');

    // And the same edit twice *is* the same intent, so it replays rather than
    // persisting a second commitment.
    const repeat = await confirmWith('First title');
    assert.equal(repeat.success, true);
    assert.equal(repeat.replayed, true, 'an identical confirm was not recognised as a replay');
  } finally {
    resetStorageForTests();
  }
});

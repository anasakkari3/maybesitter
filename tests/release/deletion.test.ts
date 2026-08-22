/**
 * Deleting a study participant, and proving it by asking the stores again.
 *
 * Not one assertion here reads a count that the deleting code returned. Every
 * proof is a re-list or a re-count against the store afterwards, and the digest
 * is recomputed by the test through the exported pure function rather than
 * compared to itself — the same discipline `deletePersonalizationScope` is
 * built on and the reason `emptyStateDigestFor` is exported there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkShadowStudyDeletionReceipt,
  type PersonalizationDeletionReceipt,
} from '../../src/contracts/v1/shadowPipelineContracts.ts';
import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { createInMemoryRuntimeMemoryStore } from '../../lib/runtimeMemory/runtimeMemoryStore.ts';
import { deletePersonalizationScope } from '../../lib/personalization/deletion.ts';
import { createInMemoryShadowStudyConsentStore } from '../../lib/release/consentStore.ts';
import { createInMemoryShadowStudyResponseStore } from '../../lib/release/studyStore.ts';
import {
  SHADOW_DELETABLE_STORES,
  createInMemoryShadowArchive,
  deleteShadowStudyParticipant,
  notWiredArchive,
  shadowEmptyStateDigest,
  shadowEmptyStatePreimage,
  wiredArchive,
  type ShadowStudyDeletionInput,
} from '../../lib/release/deletion.ts';

const P = 'participant-a';
const Q = 'participant-b';
const T1 = '2027-01-04T09:00:00.000Z';
const NOW = '2027-01-12T09:00:00.000Z';
const LATER = '2027-01-13T09:00:00.000Z';

function personalizationDeleter(): (scopeId: string, now: string) => PersonalizationDeletionReceipt {
  const feedbackEvents = createInMemoryFeedbackEventStore();
  const runtimeMemory = createInMemoryRuntimeMemoryStore();
  return (scopeId, now) => deletePersonalizationScope({ scopeId, now, feedbackEvents, runtimeMemory });
}

function inputFor(overrides: Partial<ShadowStudyDeletionInput> = {}): ShadowStudyDeletionInput {
  const consent = createInMemoryShadowStudyConsentStore();
  const responses = createInMemoryShadowStudyResponseStore();
  consent.grant(P, ['shadow_execution', 'feedback_study', 'trace_retention'], T1);
  consent.grant(Q, ['shadow_execution'], T1);
  responses.record({ status: 'rated', participantId: P, runId: 'run-0001', question: 'trust', rating: 4, respondedAt: T1 });
  responses.record({ status: 'declined', participantId: P, runId: 'run-0001', question: 'accuracy', rating: null, respondedAt: T1 });
  responses.record({ status: 'rated', participantId: Q, runId: 'run-0002', question: 'trust', rating: 5, respondedAt: T1 });

  return {
    participantId: P,
    now: NOW,
    consent,
    responses,
    traces: wiredArchive(createInMemoryShadowArchive([P, P, Q])),
    replayBundles: wiredArchive(createInMemoryShadowArchive([P, Q])),
    deletePersonalization: personalizationDeleter(),
    ...overrides,
  };
}

/* ── The receipt, and the stores it is checked against ───────────── */

test('a complete deletion yields a receipt with nothing structurally wrong with it', () => {
  const outcome = deleteShadowStudyParticipant(inputFor());
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;
  assert.deepEqual(checkShadowStudyDeletionReceipt(outcome.receipt), []);
  assert.equal(outcome.receipt.participantId, P);
  assert.equal(outcome.receipt.deletedAt, NOW);
});

test('the receipt is verified by re-listing every store, not by trusting its counts', () => {
  const input = inputFor();
  const outcome = deleteShadowStudyParticipant(input);
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;

  // The stores are asked again, one (store, count) pair at a time.
  assert.equal(input.consent.countFor(P), 0, 'a consent record survived deletion');
  assert.equal(input.consent.read(P).state, 'withheld');
  assert.deepEqual(input.responses.list(P), [], 'a study response survived deletion');
  assert.equal(input.traces.status === 'wired' ? input.traces.archive.countFor(P) : -1, 0);
  assert.equal(input.replayBundles.status === 'wired' ? input.replayBundles.archive.countFor(P) : -1, 0);

  // And the receipt agrees with what the stores just said.
  assert.equal(outcome.receipt.remainingStudyResponseCount, input.responses.countFor(P));
  assert.equal(outcome.receipt.remainingTraceCount, 0);
  assert.equal(outcome.receipt.remainingReplayBundleCount, 0);
  assert.equal(outcome.remainingConsentRecordCount, input.consent.countFor(P));
});

test('one participant deleting leaves every other participant intact', () => {
  const input = inputFor();
  deleteShadowStudyParticipant(input);
  assert.equal(input.consent.countFor(Q), 1, 'one participant deleted another participant\'s consent');
  assert.equal(input.responses.countFor(Q), 1, 'one participant deleted another participant\'s responses');
  assert.equal(input.traces.status === 'wired' ? input.traces.archive.countFor(Q) : -1, 1);
  assert.deepEqual(input.consent.listParticipants(), [Q]);
});

/* ── The digest is recomputable without calling the deleter ──────── */

test('the empty-state digest is recomputable by a verifier that never ran the deletion', () => {
  const outcome = deleteShadowStudyParticipant(inputFor());
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;
  assert.equal(outcome.receipt.emptyStateDigest, shadowEmptyStateDigest(P, NOW));
});

test('the digest binds the receipt to this participant and this instant', () => {
  const mine = shadowEmptyStateDigest(P, NOW);
  assert.notEqual(mine, shadowEmptyStateDigest(Q, NOW), 'one participant\'s receipt verifies another\'s deletion');
  assert.notEqual(mine, shadowEmptyStateDigest(P, LATER), 'last week\'s receipt verifies today\'s deletion');
  assert.match(mine, /^[0-9a-f]{64}$/);
});

test('the preimage names every store the receipt speaks for, so a new store cannot be added silently', () => {
  const preimage = shadowEmptyStatePreimage(P, NOW);
  for (const store of SHADOW_DELETABLE_STORES) {
    assert.ok(preimage.includes(store), `${store} is deletable but absent from the digest preimage`);
  }
  assert.ok(preimage.includes(P));
  assert.ok(preimage.includes(NOW));
});

/* ── A store that leaves rows behind is reported, not smoothed ───── */

test('each remainder field is probed on its own; a leftover row makes the receipt fail its own check', () => {
  const leaky = { countFor: () => 3, deleteParticipant: () => 0 };
  const cases: [string, Partial<ShadowStudyDeletionInput>][] = [
    ['traces', { traces: wiredArchive(leaky) }],
    ['replayBundles', { replayBundles: wiredArchive(leaky) }],
  ];
  for (const [name, override] of cases) {
    const outcome = deleteShadowStudyParticipant(inputFor(override));
    assert.equal(outcome.status, 'deleted', `${name}: a leaky store should still produce a receipt to fail`);
    if (outcome.status !== 'deleted') continue;
    const codes = checkShadowStudyDeletionReceipt(outcome.receipt).map((defect) => defect.code);
    assert.deepEqual(codes, ['SHADOW_RECEIPT_REMAINDER_NOT_ZERO'], `${name}: leftovers were not reported`);
  }
});

test('a defective embedded personalization receipt is re-coded rather than swallowed', () => {
  const outcome = deleteShadowStudyParticipant(
    inputFor({
      deletePersonalization: () => ({
        version: 'v1',
        schemaVersion: 'personalization-v1',
        scopeId: '',
        deletedAt: NOW,
        remainingFeedbackEventCount: 0,
        remainingRuntimeMemoryRecordCount: 0,
        remainingPersistedProfileCount: 0,
        emptyStateDigest: 'deadbeefdeadbeef',
      } as unknown as PersonalizationDeletionReceipt),
    }),
  );
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;
  const codes = checkShadowStudyDeletionReceipt(outcome.receipt).map((defect) => defect.code);
  assert.deepEqual(codes, ['SHADOW_NESTED_RECEIPT_DEFECT']);
});

/* ── An unwired store cannot be proven empty, and says so ────────── */

test('an unwired archive deletes what it can and refuses to claim what it cannot', () => {
  const input = inputFor({ traces: notWiredArchive('issue_45_shadow_trace_store') });
  const outcome = deleteShadowStudyParticipant(input);
  assert.equal(outcome.status, 'deleted_unproven');
  if (outcome.status !== 'deleted_unproven') return;
  assert.deepEqual(outcome.unprovable, ['traces']);
  assert.ok(outcome.detail.includes('issue_45_shadow_trace_store'));

  // The deletion still happened everywhere it could: proven by re-listing.
  assert.equal(input.consent.countFor(P), 0, 'an unprovable store blocked a deletion that could have happened');
  assert.equal(input.responses.countFor(P), 0);
  assert.equal(input.replayBundles.status === 'wired' ? input.replayBundles.archive.countFor(P) : -1, 0);
});

test('an unwired personalization deleter is named as unprovable too', () => {
  const outcome = deleteShadowStudyParticipant(inputFor({ deletePersonalization: undefined }));
  assert.equal(outcome.status, 'deleted_unproven');
  if (outcome.status !== 'deleted_unproven') return;
  assert.deepEqual(outcome.unprovable, ['personalization']);
});

test('every unprovable store is named, not just the first', () => {
  const outcome = deleteShadowStudyParticipant(
    inputFor({
      traces: notWiredArchive('issue_45_shadow_trace_store'),
      replayBundles: notWiredArchive('issue_45_replay_bundle_store'),
      deletePersonalization: undefined,
    }),
  );
  assert.equal(outcome.status, 'deleted_unproven');
  if (outcome.status !== 'deleted_unproven') return;
  assert.deepEqual(outcome.unprovable, ['traces', 'replay_bundles', 'personalization']);
});

test('the removed tally reports null for a store that could not be acted on, not zero', () => {
  const outcome = deleteShadowStudyParticipant(inputFor({ traces: notWiredArchive('issue_45_shadow_trace_store') }));
  assert.equal(outcome.status, 'deleted_unproven');
  if (outcome.status !== 'deleted_unproven') return;
  assert.equal(outcome.removed.traces, null, 'an unwired store reported zero removals as though it had looked');
  assert.equal(outcome.removed.consent, 1);
  assert.equal(outcome.removed.study_responses, 2);
  assert.equal(outcome.removed.replay_bundles, 1);
});

test('deleting a participant who has nothing stored is still a clean, verifiable deletion', () => {
  const outcome = deleteShadowStudyParticipant(inputFor({ participantId: 'participant-z' }));
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;
  assert.deepEqual(checkShadowStudyDeletionReceipt(outcome.receipt), []);
  assert.equal(outcome.removed.consent, 0);
  assert.equal(outcome.receipt.emptyStateDigest, shadowEmptyStateDigest('participant-z', NOW));
});

test('a malformed instant is refused rather than written into a receipt nobody can verify', () => {
  const outcome = deleteShadowStudyParticipant(inputFor({ now: '2026-02-30' as never }));
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.reason, 'malformed_instant');
});

test('an unsafe participant id is refused rather than used to delete something adjacent', () => {
  const outcome = deleteShadowStudyParticipant(inputFor({ participantId: '../../etc' }));
  assert.equal(outcome.status, 'refused');
  if (outcome.status !== 'refused') return;
  assert.equal(outcome.reason, 'unsafe_participant');
});

test('a store that reports a deletion and keeps the rows makes the receipt fail its own check', () => {
  // The one failure a re-listed remainder exists to catch: `deleteParticipant`
  // returns a count and the rows are still there.
  const input = inputFor();
  const held = input.responses.list(P);
  const lying = {
    ...input.responses,
    deleteParticipant: () => held.length,
    countFor: () => held.length,
    list: () => held,
  };
  const outcome = deleteShadowStudyParticipant({ ...input, responses: lying });
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;
  assert.equal(outcome.receipt.remainingStudyResponseCount, held.length);
  assert.deepEqual(
    checkShadowStudyDeletionReceipt(outcome.receipt).map((defect) => defect.code),
    ['SHADOW_RECEIPT_REMAINDER_NOT_ZERO'],
    'a receipt reported zero for a store that still held rows',
  );
});

test('a lying consent store cannot buy a clean receipt, because consent has no receipt field', () => {
  // The gap the test above cannot cover. `ShadowStudyDeletionReceipt` carries
  // three remainders and consent is not one of them, so the arrangement that
  // catches a lying response store — issue the receipt, let its own checker
  // refuse it — has nothing to refuse here.
  //
  // Before this guard, an integration review handed exactly this store to the
  // deleter and got `status: 'deleted'`, **zero defects** from
  // `checkShadowStudyDeletionReceipt`, and a digest that recomputes, while the
  // participant's granted scopes stayed fully readable. A receipt is a claim of
  // emptiness; no receipt may be issued for a scope known not to be empty.
  const input = inputFor();
  const held = input.consent.read(P);
  const lying = {
    ...input.consent,
    deleteParticipant: () => 1,
    countFor: () => 1,
    read: () => held,
  };
  const outcome = deleteShadowStudyParticipant({ ...input, consent: lying });

  assert.equal(outcome.status, 'deleted_unproven', 'a clean receipt was issued while consent survived');
  if (outcome.status !== 'deleted_unproven') return;
  assert.deepEqual(outcome.unprovable, ['consent']);
  assert.match(outcome.detail, /consent/);
  assert.equal(outcome.remainingConsentRecordCount, 1);
  // And no receipt at all — the point is that there is nothing to hand someone.
  assert.equal((outcome as Record<string, unknown>).receipt, undefined);
});

test('an honest consent store still yields a receipt: the guard refuses remainders, not deletions', () => {
  // The other direction. A guard that refused everything would pass the test
  // above while making deletion unusable.
  const outcome = deleteShadowStudyParticipant(inputFor());
  assert.equal(outcome.status, 'deleted');
  if (outcome.status !== 'deleted') return;
  assert.equal(outcome.remainingConsentRecordCount, 0);
  assert.deepEqual(checkShadowStudyDeletionReceipt(outcome.receipt), []);
});

test('each archive is separately load-bearing: unwiring either one alone is reported', () => {
  const cases: [string, Partial<ShadowStudyDeletionInput>][] = [
    ['traces', { traces: notWiredArchive('issue_45_shadow_trace_store') }],
    ['replay_bundles', { replayBundles: notWiredArchive('issue_45_replay_bundle_store') }],
  ];
  for (const [store, override] of cases) {
    const outcome = deleteShadowStudyParticipant(inputFor(override));
    assert.equal(outcome.status, 'deleted_unproven', `${store} unwired still produced a receipt`);
    if (outcome.status !== 'deleted_unproven') continue;
    assert.deepEqual(outcome.unprovable, [store]);
  }
});

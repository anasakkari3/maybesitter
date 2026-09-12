/**
 * Confirming once, against real Firestore (UC-1.4, #148).
 *
 * The memory adapter serialises transactions inside one process, so a race that
 * it survives says nothing about two Cloud Run instances. #252 already taught
 * this the expensive way: a shape every memory-backed test accepted was refused
 * by Firestore on the first real request. So the exactly-once claim is made
 * here, where the transaction is the database's.
 *
 * ── What is being proven ─────────────────────────────────────────
 *
 * The commitments and the proposal's `confirmedResult` are written in one
 * transaction. Whichever of two racing confirms commits second therefore reads
 * the first one's result and replays it, instead of persisting a second set of
 * commitments for one tap.
 *
 * The cross-instance read uses a second adapter instance rather than the one
 * that wrote, because "another instance can see it" is the actual promise —
 * shared object identity inside one process would prove nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage, resetFirestoreForTests } from '../../lib/storage/firestoreAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { loadDomainState } from '../../lib/services/mobile/participantState.ts';
import { userCol } from '../../lib/storage/paths.ts';
import { CAPTURE_PROPOSALS } from '../../lib/storage/paths.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';

/** A fresh uid per run, so a rerun never reads the last one's documents. */
function uniqueUid(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

async function cleanUp(uid: string): Promise<void> {
  await createFirestoreStorage().deleteTree(`users/${uid}`);
}

test('firestore: two confirms of one proposal persist one set of commitments', async () => {
  const uid = uniqueUid('confirm_race');
  setStorageForTests(createFirestoreStorage());
  try {
    const proposal = await proposeMobileCapture(
      { text: 'Call the pharmacy tomorrow at 10', timezone: 'UTC' },
      { participantId: uid },
    );
    assert.equal(proposal.status, 'proposed', 'the capture produced no proposal to confirm');
    const itemIds = [proposal.items[0]!.itemId];

    const confirm = () => confirmMobileCapture({ proposalId: proposal.proposalId, itemIds }, { participantId: uid });
    const [a, b] = await Promise.all([confirm(), confirm()]);

    assert.equal(a.success, true, `first confirm failed: ${a.failureCode ?? ''}`);
    assert.equal(b.success, true, `second confirm failed: ${b.failureCode ?? ''}`);
    assert.equal(
      [a.replayed, b.replayed].filter(Boolean).length,
      1,
      `exactly one confirm should replay, got ${JSON.stringify([a.replayed, b.replayed])}`,
    );

    // Read through an adapter that did not write any of this.
    const otherInstance = createFirestoreStorage();
    const state = await loadDomainState(otherInstance, uid);
    const commitments = Object.values(state.commitments);
    assert.equal(commitments.length, 1, `one tap produced ${commitments.length} commitments in Firestore`);
    assert.deepEqual(
      a.persisted.map((item) => item.commitmentId),
      b.persisted.map((item) => item.commitmentId),
      'the two responses describe different commitments',
    );

    // The claim really is on the proposal document, not in this process.
    const proposals = await otherInstance.list<{ confirmedResult?: unknown }>(userCol(uid, CAPTURE_PROPOSALS));
    assert.equal(proposals.length, 1);
    assert.ok(proposals[0]!.data.confirmedResult, 'the confirmation was not recorded on the proposal');
  } finally {
    resetStorageForTests();
    await cleanUp(uid);
    resetFirestoreForTests();
  }
});

test('firestore: a later confirm replays the first result rather than persisting again', async () => {
  const uid = uniqueUid('confirm_replay');
  setStorageForTests(createFirestoreStorage());
  try {
    const proposal = await proposeMobileCapture(
      { text: 'Email the landlord tomorrow at 11', timezone: 'UTC' },
      { participantId: uid },
    );
    const itemIds = [proposal.items[0]!.itemId];

    const first = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds }, { participantId: uid });
    const second = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds }, { participantId: uid });

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true, 'the repeated confirm did not report a replay');
    assert.deepEqual(
      second.persisted.map((item) => item.commitmentId),
      first.persisted.map((item) => item.commitmentId),
      'the replay described a different commitment',
    );

    const state = await loadDomainState(createFirestoreStorage(), uid);
    assert.equal(Object.keys(state.commitments).length, 1);
  } finally {
    resetStorageForTests();
    await cleanUp(uid);
    resetFirestoreForTests();
  }
});

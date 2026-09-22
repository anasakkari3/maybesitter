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
 *
 * ── Why the emulator suite is concurrency-capped ─────────────────
 *
 * This file used to fail about one run in two with `persistence_failed`, and
 * the cause was never in the code under test (#419). `npm test` runs one file
 * per process at `--test-concurrency` = core count, which on a 15-core machine
 * points fifteen test processes at a single Firestore emulator JVM. Under that
 * much load the emulator's transaction locks time out, the confirm below
 * spends all five of its attempts losing the race, and Firestore raises
 * `ABORTED`. Measured: alone this test needs two attempts and 3.2s; in a
 * fully-parallel suite it took up to 18.8s, and exhausted the budget.
 *
 * So `test:emulator:attach` caps `--test-concurrency`. That is not a retry and
 * not a sleep: it stops oversubscribing one emulator, which is what
 * manufactured the contention. The two confirms below still race each other —
 * that race is the point of the test and is unchanged.
 *
 * Measured over 35 capped suite runs: no `ABORTED` at all, and this test's
 * duration back to roughly what it costs alone. Four rather than two on
 * purpose — at two the remaining failures were no rarer and the suite took
 * about a quarter longer, so two bought nothing.
 *
 * **This is a reduction, not a proof of zero.** A second and distinct symptom
 * survives at roughly one run in fifteen: `INVALID_ARGUMENT: Transaction is
 * invalid or closed`, the emulator timing out a transaction rather than
 * refusing a write. Lowering the cap did not move it. The likely reason it is
 * reachable at all is that `commitCaptureConfirmation` reads the whole domain
 * state and the activity stats before it writes, which is a long read phase to
 * hold a transaction open for — but that is a claim about production
 * transaction shape and was not changed here. So if this file fails, read the
 * cause in the message first: `whyItFailed` below names it, and only an
 * unrecognised status is worth suspecting the durability claim over.
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

/**
 * A failure message that names the cause, so the next person does not have to
 * re-run the job to learn it (#419).
 *
 * This test used to print `first confirm failed: persistence_failed` and stop
 * there — the same line whether the durability claim had broken or the emulator
 * was merely busy. `failureCause` carries the gRPC status, which is what
 * actually separates them.
 *
 * It deliberately stops short of a verdict on anything it does not recognise,
 * and the list below was earned rather than guessed. An earlier draft called
 * everything that was not `ABORTED` a real durability failure that a re-run
 * would not clear; the first run to disagree failed with `INVALID_ARGUMENT`
 * and passed on the next attempt. The operator log line this now points at is
 * what identified it — `Transaction is invalid or closed`, the emulator timing
 * a transaction out — which is a load symptom wearing the status of a refused
 * write. Anything still unrecognised is reported as *unclassified*, never as a
 * regression.
 */
const KNOWN_LOAD_SYMPTOMS = [
  'ABORTED',
  'UNAVAILABLE',
  'DEADLINE_EXCEEDED',
  'RESOURCE_EXHAUSTED',
  // The emulator closing a transaction it decided had taken too long. Reported
  // as `INVALID_ARGUMENT (transaction closed)`, because the bare status means
  // a refused write and this is not one — see `RECOGNISED_MESSAGES`.
  'INVALID_ARGUMENT (transaction closed)',
];

function whyItFailed(which: string, result: { failureCode?: string; failureCause?: string }): string {
  if (result.failureCause === undefined) return `${which} confirm failed: ${result.failureCode ?? 'no failureCode'}`;
  const load = result.failureCause.startsWith('contention') || KNOWN_LOAD_SYMPTOMS.includes(result.failureCause);
  return `${which} confirm failed: ${result.failureCode} (${result.failureCause}). `
    + (load
      ? 'That is a known load symptom, not a durability regression: this file races two confirms on purpose and '
        + 'every attempt in the budget was lost. The emulator is oversubscribed — `test:emulator:attach` caps '
        + '`--test-concurrency` for exactly this reason (#419), so the cap needs lowering, or the machine is busy.'
      : 'That is not one of the statuses this suite is known to produce under load '
        + `(${KNOWN_LOAD_SYMPTOMS.join(', ')}), so it is UNCLASSIFIED — it may still be load-related. Read the `
        + '`[capture/confirm]` line logged just above: it carries the full Firestore message, which says which '
        + 'argument or precondition was refused. Do not conclude a durability regression from this line alone.');
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

    assert.equal(a.success, true, whyItFailed('first', a));
    assert.equal(b.success, true, whyItFailed('second', b));
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

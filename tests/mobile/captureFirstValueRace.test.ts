/**
 * A capture that was saved is reported as saved (#153).
 *
 * `confirmMobileCapture` persists and activates the commitment, and only then
 * records the first-value marker and its analytics event. That bookkeeping used
 * to be able to throw out of the whole confirm: the route answered HTTP 400 and
 * the client was told the capture had failed, while the commitment sat safely in
 * storage.
 *
 * It throws for a reason that only appears with more than one instance. Two
 * confirms racing on separate instances both read `firstValueAt: null` and both
 * send `record_first_value`; one commits, and the other arrives carrying the
 * earlier timestamp, which the trust rules rejected as backdated. #153's staging
 * run showed it as eight captures accepted and seven commitments reported.
 *
 * The first test pins the boundary — bookkeeping cannot decide the answer — by
 * stamping the trust record ahead of this process, which is exactly what the
 * losing side of that race sees. The second drives the race itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { applyTrustAction, getOrCreateTrust, readTrust } from '../../lib/pilot/pilotTrustStore.ts';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';

const TEXT = 'Remind me to call the dentist tomorrow at 3pm';

async function captureAndConfirm(uid: string) {
  const proposal = await proposeMobileCapture({ text: TEXT, timezone: 'UTC' }, { participantId: uid });
  assert.equal(proposal.status, 'proposed', 'the capture produced no proposal to confirm');
  return confirmMobileCapture(
    { proposalId: proposal.proposalId, itemIds: [proposal.items[0]!.itemId] },
    { participantId: uid },
  );
}

test('a saved commitment is reported saved even when the first-value bookkeeping cannot be written', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const uid = 'user_clock_behind';
    await getOrCreateTrust(uid, new Date().toISOString());
    // Stamped an hour ahead: every action this process sends is now "backdated"
    // relative to the record, which is the losing side of the race.
    const ahead = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await applyTrustAction(uid, { type: 'set_quiet_mode', enabled: false, at: ahead });

    const result = await captureAndConfirm(uid);

    assert.equal(result.success, true, `confirm failed: ${result.failureCode ?? ''}`);
    assert.equal(result.persisted.length, 1, 'the commitment was not reported as persisted');
    // The marker really is absent. The point is not that it was written anyway,
    // it is that failing to write it does not lose the user their capture.
    assert.equal((await readTrust(uid))?.firstValueAt ?? null, null);
  } finally {
    resetStorageForTests();
  }
});

test('two captures confirmed at the same time both keep their commitments', async () => {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  try {
    const uid = 'user_racing_confirms';
    await getOrCreateTrust(uid, new Date().toISOString());

    const results = await Promise.all([captureAndConfirm(uid), captureAndConfirm(uid)]);

    results.forEach((result, index) => {
      assert.equal(result.success, true, `confirm ${index} failed: ${result.failureCode ?? ''}`);
      assert.equal(result.persisted.length, 1, `confirm ${index} reported nothing persisted`);
    });
    // One of them won the race and the marker is set once, for the whole user.
    assert.ok((await readTrust(uid))?.firstValueAt, 'no first value was ever recorded');
  } finally {
    resetStorageForTests();
  }
});

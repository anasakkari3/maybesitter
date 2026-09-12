/**
 * The capture proposal store against real Firestore (#252, and the bug that
 * fix shipped).
 *
 * Every test written for #252 used the memory adapter, which stores whatever
 * JSON accepts. Firestore does not: it rejects nested arrays outright. The
 * proposal's commands were serialised as `[[itemId, [...commands]]]` — an
 * array of arrays — so the durable store worked perfectly in `npm test` and
 * answered 400 on the first real capture in staging.
 *
 * This is the round trip that had to run against the emulator to catch it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFirestoreStorage } from '../../lib/storage/firestoreAdapter.ts';
import { StorageCaptureProposalStore } from '../../lib/services/captureBoundary/proposalStore.ts';
import { userDoc } from '../../lib/storage/paths.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

const CONTRACT = {
  version: 'capture-v1',
  proposalId: '',
  status: 'proposed',
  items: [{ itemId: 'item-1', title: 'Call the doctor', resolvedTime: null, needsClarification: false }],
  provenance: { requestedEngine: 'model', executedEngine: 'rule-based', fallbackUsed: false },
} as const;

test('firestore: a proposal round-trips with its commands intact', async () => {
  const storage = createFirestoreStorage();
  const uid = `capture_${Date.now().toString(36)}`;
  const proposalId = `p-${Date.now().toString(36)}`;
  const commands = [{ type: 'CreateDraft', now: '2026-08-17T08:00:00.000Z', commitment: { id: 'cmt_1', kind: 'task', title: 'Call the doctor', timeSpec: { kind: 'due_by', dueAt: '2026-08-17T12:00:00.000Z', remindAt: '2026-08-17T12:00:00.000Z', timezone: 'UTC' } }, draftStatus: 'pending_confirmation' }] as unknown as Command[];

  const store = new StorageCaptureProposalStore(storage);
  try {
    // This is the call that threw in staging.
    await store.put({
      contract: { ...CONTRACT, proposalId } as never,
      scopeId: uid,
      commandsByItemId: new Map([['item-1', commands]]),
    });

    const readBack = await new StorageCaptureProposalStore(storage).get(proposalId);
    assert.ok(readBack, 'the proposal was not stored');
    const back = readBack.commandsByItemId.get('item-1');
    assert.ok(back && back.length === 1, 'the commands did not survive Firestore');
    assert.equal((back[0] as { type: string }).type, 'CreateDraft');
  } finally {
    await storage.deleteTree(userDoc(uid));
  }
});

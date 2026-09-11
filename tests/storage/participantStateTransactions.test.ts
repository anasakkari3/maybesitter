/**
 * The two races the file-backed participant store could not survive.
 *
 * The old store serialised writes through an in-process `Map` of promise
 * queues, which a second Cloud Run instance does not participate in: both
 * instances read the whole `DomainState`, both applied their command, and the
 * later write erased the earlier one. These tests run the concurrent case that
 * would have lost writes, with a *competing write injected between every
 * transaction's last read and its commit* — the window a second instance
 * occupies — and assert that nothing is lost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyParticipantCommand,
  getParticipantStateSnapshot,
  replayOrRecordParticipantDecision,
} from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage, type MemoryStorageAdapter } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { COMMITMENTS, EVENTS, RECOMMENDATION_ACTIONS, userCol, userDoc } from '../../lib/storage/paths.ts';
import type { UserDocument } from '../../lib/storage/userDocument.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

const UID = 'p-900';
const NOW = '2026-08-09T08:00:00.000Z';
const CONCURRENCY = 20;

function setup(): { storage: MemoryStorageAdapter; cleanup: () => void } {
  const storage = createMemoryStorage();
  setStorageForTests(storage);
  return {
    storage,
    cleanup: () => {
      storage.setBeforeCommitHookForTests(null);
      resetStorageForTests();
    },
  };
}

function createDraft(id: string): Command {
  return {
    type: 'CreateDraft',
    now: NOW,
    draftStatus: 'pending_confirmation',
    commitment: {
      id,
      kind: 'task',
      title: `Task ${id}`,
      timeSpec: {
        kind: 'due_by',
        dueAt: '2026-08-10T09:00:00.000Z',
        remindAt: '2026-08-10T09:00:00.000Z',
        timezone: 'UTC',
      },
    },
  };
}

test('20 concurrent commands with an injected competing write lose nothing', async () => {
  const { storage, cleanup } = setup();
  try {
    // A competing write to a document every one of these transactions reads,
    // landing after its last read. It preserves `domainVersion`, so the only
    // thing it changes is the document's version — which is exactly what a
    // second instance's unrelated write to the same user would do.
    let injected = 0;
    storage.setBeforeCommitHookForTests(async () => {
      if (injected >= CONCURRENCY) return;
      injected += 1;
      const user = await storage.get<Record<string, unknown>>(userDoc(UID));
      await storage.set(userDoc(UID), { ...(user ?? {}), contentionProbe: injected });
    });

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_unused, index) =>
        applyParticipantCommand(UID, createDraft(`task-${String(index).padStart(2, '0')}`)),
      ),
    );
    assert.equal(results.every((result) => result.result === 'applied'), true);
    assert.equal(injected, CONCURRENCY, 'the competing write never landed, so no retry was exercised');

    const state = await getParticipantStateSnapshot(UID);
    assert.equal(Object.keys(state.commitments).length, CONCURRENCY);

    // The number that tells "twenty writes landed" from "twenty writes raced
    // and four were lost".
    const user = await storage.get<UserDocument>(userDoc(UID));
    assert.equal(user?.domainVersion, CONCURRENCY);

    const events = await storage.list(userCol(UID, EVENTS));
    assert.equal(events.length, CONCURRENCY);
    const commitments = await storage.list(userCol(UID, COMMITMENTS));
    assert.equal(commitments.length, CONCURRENCY);
  } finally {
    cleanup();
  }
});

test('two concurrent identical decisions record one document and replay the other', async () => {
  const { storage, cleanup } = setup();
  try {
    const fingerprint = JSON.stringify({ proposalId: 'proposal-1', decision: 'accept' });
    let created = 0;
    const create = () => {
      created += 1;
      return { recorded: 'accept' as const };
    };

    const results = await Promise.all([
      replayOrRecordParticipantDecision(UID, 'same-key', fingerprint, create),
      replayOrRecordParticipantDecision(UID, 'same-key', fingerprint, create),
    ]);

    const stored = await storage.list(userCol(UID, RECOMMENDATION_ACTIONS));
    assert.equal(stored.length, 1, 'a second document was written for one idempotency key');
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    // Both callers see the same answer: the replay returns what was recorded,
    // not what the losing attempt computed.
    assert.deepEqual(results[0].response, results[1].response);
    // The losing attempt's callback still ran, which is precisely why it has
    // to be pure. `pilotService.recordMobileNextStepDecision` emits its
    // analytics event after the transaction, gated on `replayed === false`.
    assert.ok(created >= 1);
  } finally {
    cleanup();
  }
});

test('a decision replayed with a different body is refused rather than overwritten', async () => {
  const { cleanup } = setup();
  try {
    await replayOrRecordParticipantDecision(UID, 'key-1', 'fingerprint-a', () => ({ n: 1 }));
    await assert.rejects(
      replayOrRecordParticipantDecision(UID, 'key-1', 'fingerprint-b', () => ({ n: 2 })),
      /idempotencyKey body mismatch/,
    );
    const replayed = await replayOrRecordParticipantDecision(UID, 'key-1', 'fingerprint-a', () => ({ n: 3 }));
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.response, { n: 1 });
  } finally {
    cleanup();
  }
});

test('a command that changes nothing writes nothing and does not move the version', async () => {
  const { storage, cleanup } = setup();
  try {
    await applyParticipantCommand(UID, createDraft('only'));
    const before = (await storage.get<UserDocument>(userDoc(UID)))?.domainVersion;

    const missing = await applyParticipantCommand(UID, {
      type: 'Complete',
      commitmentId: 'does-not-exist',
      now: NOW,
    });
    assert.equal(missing.result, 'rejected');
    assert.equal((await storage.get<UserDocument>(userDoc(UID)))?.domainVersion, before);
  } finally {
    cleanup();
  }
});

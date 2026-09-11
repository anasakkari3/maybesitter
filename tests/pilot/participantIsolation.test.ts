import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyParticipantCommand,
  deleteParticipantDomainState,
  getParticipantStateSnapshot,
} from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

const NOW = '2026-08-09T08:00:00.000Z';

/**
 * Participant state lives in storage since UC-1.0b (#141), so isolation is a
 * fresh adapter rather than a fresh data directory.
 */
function setup(): () => void {
  setStorageForTests(createMemoryStorage());
  return () => {
    resetStorageForTests();
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

async function createActive(participantId: string, id: string): Promise<void> {
  assert.equal((await applyParticipantCommand(participantId, createDraft(id))).result, 'applied');
  assert.equal((await applyParticipantCommand(participantId, {
    type: 'ConfirmCommitment',
    commitmentId: id,
    now: NOW,
  })).result, 'applied');
}

test('participant state adapter isolates A and B without command-service reconfiguration', async () => {
  const cleanup = setup();
  try {
    await createActive('p-100', 'a-only');
    await createActive('p-101', 'b-only');

    assert.equal((await getParticipantStateSnapshot('p-100')).commitments['a-only'].status, 'active');
    assert.equal((await getParticipantStateSnapshot('p-100')).commitments['b-only'], undefined);
    assert.equal((await getParticipantStateSnapshot('p-101')).commitments['b-only'].status, 'active');
    assert.equal((await getParticipantStateSnapshot('p-101')).commitments['a-only'], undefined);
  } finally {
    cleanup();
  }
});

// The old in-process promise queue is gone; what keeps these twelve writes is
// the storage transaction, which a second instance would also take part in.
test('same-participant concurrent writes are preserved by transactional storage', async () => {
  const cleanup = setup();
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => createActive('p-200', `task-${index}`)),
    );
    const commitments = Object.values((await getParticipantStateSnapshot('p-200')).commitments);
    assert.equal(commitments.length, 12);
    assert.equal(commitments.every((commitment) => commitment.status === 'active'), true);
  } finally {
    cleanup();
  }
});

test('participant-local deletion removes only the requested participant state', async () => {
  const cleanup = setup();
  try {
    await createActive('p-300', 'delete-me');
    await createActive('p-301', 'keep-me');

    await deleteParticipantDomainState('p-300');

    assert.equal(Object.keys((await getParticipantStateSnapshot('p-300')).commitments).length, 0);
    assert.equal((await getParticipantStateSnapshot('p-301')).commitments['keep-me'].status, 'active');
  } finally {
    cleanup();
  }
});

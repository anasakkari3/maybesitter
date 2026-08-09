import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyParticipantCommand,
  deleteParticipantDomainState,
  getParticipantStateSnapshot,
} from '../../lib/services/mobile/participantState.ts';
import type { Command } from '../../src/domain/stateMachine.ts';

const NOW = '2026-08-09T08:00:00.000Z';

function setup(): () => void {
  const directory = mkdtempSync(join(tmpdir(), 'maybesitter-participant-state-'));
  const previous = process.env.MAYBESITTER_DATA_DIR;
  process.env.MAYBESITTER_DATA_DIR = directory;
  return () => {
    if (previous === undefined) delete process.env.MAYBESITTER_DATA_DIR;
    else process.env.MAYBESITTER_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
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

    assert.equal(getParticipantStateSnapshot('p-100').commitments['a-only'].status, 'active');
    assert.equal(getParticipantStateSnapshot('p-100').commitments['b-only'], undefined);
    assert.equal(getParticipantStateSnapshot('p-101').commitments['b-only'].status, 'active');
    assert.equal(getParticipantStateSnapshot('p-101').commitments['a-only'], undefined);
  } finally {
    cleanup();
  }
});

test('participant-keyed serialization preserves same-participant concurrent writes', async () => {
  const cleanup = setup();
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => createActive('p-200', `task-${index}`)),
    );
    const commitments = Object.values(getParticipantStateSnapshot('p-200').commitments);
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

    assert.equal(Object.keys(getParticipantStateSnapshot('p-300').commitments).length, 0);
    assert.equal(getParticipantStateSnapshot('p-301').commitments['keep-me'].status, 'active');
  } finally {
    cleanup();
  }
});

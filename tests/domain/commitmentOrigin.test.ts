import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyDomainState, applyCommand, normalizeStoredCommitment } from '../../src/domain/stateMachine.ts';

const NOW = '2026-09-16T09:00:00.000Z';

test('a commitment is the user\'s unless it says otherwise', () => {
  const { newState } = applyCommand(createEmptyDomainState(), {
    type: 'CreateDraft', now: NOW,
    commitment: { id: 'c1', kind: 'task', title: 'Call the dentist' },
  });
  assert.equal(newState.commitments.c1.origin, 'user');
});

test('a feed can say a commitment is its own', () => {
  const { newState } = applyCommand(createEmptyDomainState(), {
    type: 'CreateDraft', now: NOW,
    commitment: { id: 'c2', kind: 'task', title: 'Barcelona v Real Madrid', origin: 'external_feed' },
  });
  assert.equal(newState.commitments.c2.origin, 'external_feed');
});

test('a commitment stored before this field reads as the user\'s', () => {
  // Every commitment written before today was typed by a person. Reading a
  // missing field as external_feed would hand the sync permission to rewrite
  // and delete commitments it never created.
  const stored = normalizeStoredCommitment({ id: 'old', kind: 'task', title: 'x', status: 'active' } as never);
  assert.equal(stored.origin, 'user');
});

test('an unrecognised stored origin reads as the user\'s', () => {
  const stored = normalizeStoredCommitment({ id: 'odd', kind: 'task', title: 'x', status: 'active', origin: 'whatever' } as never);
  assert.equal(stored.origin, 'user');
});

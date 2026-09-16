/**
 * The category field on the domain commitment (#415).
 *
 * Two invariants carry the weight here, and both are about provenance rather
 * than about the category itself:
 *
 *  1. An uncategorised commitment is the normal case, not a degraded one. It
 *     is created with `null` and nothing downstream may read that as an error.
 *  2. An inference never overwrites a decision. Once the user has said where
 *     something belongs, a later extraction that disagrees is wrong by
 *     definition — and the state machine is the only place that can enforce
 *     it, because it is the only place both values are in hand.
 *
 * The no-op guard is tested on purpose: `UpdateCommitment` short-circuits when
 * nothing changed, and a field missing from that comparison is a change the
 * user makes that silently does not persist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { DomainState } from '../../src/domain/stateMachine.ts';

const now = '2026-04-08T09:00:00.000Z';
const later = '2026-04-08T11:00:00.000Z';

function createDraft(state: DomainState, category?: 'work' | 'family' | null): DomainState {
  return applyCommand(state, {
    type: 'CreateDraft',
    now,
    commitment: {
      id: 'cmt_1',
      kind: 'task',
      title: 'Send invoice',
      ...(category === undefined ? {} : { category }),
    },
    draftStatus: 'pending_confirmation',
  }).newState;
}

test('a commitment captured with no category is created uncategorised, not failed', () => {
  const state = createDraft(createEmptyDomainState());
  assert.equal(state.commitments.cmt_1.category, null);
  assert.equal(state.commitments.cmt_1.categorySource, 'inferred');
});

test('a category the extraction resolved is kept on the draft', () => {
  const state = createDraft(createEmptyDomainState(), 'work');
  assert.equal(state.commitments.cmt_1.category, 'work');
  assert.equal(state.commitments.cmt_1.categorySource, 'inferred');
});

test('a user filing a commitment marks the category as theirs', () => {
  let state = createDraft(createEmptyDomainState());
  state = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { category: 'family' },
  }).newState;
  assert.equal(state.commitments.cmt_1.category, 'family');
  assert.equal(state.commitments.cmt_1.categorySource, 'user_explicit');
});

test('changing only the category is a change the commitment records', () => {
  let state = createDraft(createEmptyDomainState(), 'work');
  const result = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { category: 'family' },
  });
  assert.equal(result.didChange, true);
  assert.equal(result.newState.commitments.cmt_1.updatedAt, later);
});

test('a user clearing the category is a decision, not an absence of one', () => {
  let state = createDraft(createEmptyDomainState(), 'work');
  state = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { category: null },
  }).newState;
  assert.equal(state.commitments.cmt_1.category, null);
  assert.equal(state.commitments.cmt_1.categorySource, 'user_explicit');
});

test('an inference does not overwrite a category the user chose', () => {
  let state = createDraft(createEmptyDomainState());
  state = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { category: 'family' },
  }).newState;

  const result = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: '2026-04-08T12:00:00.000Z',
    updates: { category: 'work', categorySource: 'inferred' },
  });

  assert.equal(result.newState.commitments.cmt_1.category, 'family');
  assert.equal(result.newState.commitments.cmt_1.categorySource, 'user_explicit');
  assert.equal(result.didChange, false);
});

test('an inference may still fill a category the user never set', () => {
  let state = createDraft(createEmptyDomainState());
  state = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { category: 'work', categorySource: 'inferred' },
  }).newState;
  assert.equal(state.commitments.cmt_1.category, 'work');
  assert.equal(state.commitments.cmt_1.categorySource, 'inferred');
});

test('an update that touches only the title leaves the category alone', () => {
  let state = createDraft(createEmptyDomainState(), 'work');
  state = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { title: 'Send the invoice today' },
  }).newState;
  assert.equal(state.commitments.cmt_1.category, 'work');
});

test('re-filing a commitment under the category it already has is not a change', () => {
  let state = createDraft(createEmptyDomainState(), 'work');
  const result = applyCommand(state, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_1',
    now: later,
    updates: { category: 'work', categorySource: 'inferred' },
  });
  assert.equal(result.didChange, false);
});

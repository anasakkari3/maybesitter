/**
 * Canonicalization and digest tests for the Life-State projection.
 *
 * The digest is the mechanism that makes a projection replayable: a replay can
 * only prove it ran against the same inputs if two structurally identical inputs
 * hash identically. JavaScript object key order is insertion order, so these
 * tests deliberately build the same state with different key orders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalizeLifeStateInput,
  computeInputDigest,
  resolveWindowDays,
  type ResolvedLifeStateInput,
} from '../../lib/lifeState/canonicalInput.ts';
import { DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS } from '../../src/contracts/v1/lifeStateContracts.ts';
import type { Commitment, DomainState } from '../../src/domain/stateMachine.ts';

const NOW = '2026-08-18T12:00:00.000Z';

/** Written field-by-field on purpose: these tests are about key order. */
function commitmentAlpha(): Commitment {
  return {
    id: 'c_alpha',
    kind: 'task',
    title: 'Alpha',
    description: null,
    person: null,
    status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'due_by', dueAt: '2026-08-19T09:00:00.000Z', remindAt: null, timezone: 'UTC' },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-08-10T08:00:00.000Z',
    updatedAt: '2026-08-11T08:00:00.000Z',
    confirmedAt: null,
    completedAt: null,
    droppedAt: null,
  };
}

/** Same commitment, every object literal written in a different field order. */
function commitmentAlphaShuffled(): Commitment {
  return {
    droppedAt: null,
    completedAt: null,
    confirmedAt: null,
    updatedAt: '2026-08-11T08:00:00.000Z',
    createdAt: '2026-08-10T08:00:00.000Z',
    postponedUntil: null,
    currentAckState: 'not_seen',
    timeSpec: { timezone: 'UTC', remindAt: null, dueAt: '2026-08-19T09:00:00.000Z', kind: 'due_by' },
    priority: { pressureLevel: 'none', pressureAllowed: false, source: 'default', level: 'normal' },
    status: 'active',
    person: null,
    description: null,
    title: 'Alpha',
    kind: 'task',
    id: 'c_alpha',
  };
}

function commitmentBeta(): Commitment {
  return { ...commitmentAlpha(), id: 'c_beta', title: 'Beta', updatedAt: '2026-08-12T08:00:00.000Z' };
}

function resolved(state: DomainState, windowDays = DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS): ResolvedLifeStateInput {
  return { state, now: NOW, scopeId: 'scope-1', windowDays };
}

test('canonicalization sorts object keys so key order cannot leak into the digest', () => {
  const insertionOrderA: DomainState = {
    commitments: { c_beta: commitmentBeta(), c_alpha: commitmentAlpha() },
    reminders: {},
    escalationStates: {},
  };
  const insertionOrderB: DomainState = {
    escalationStates: {},
    reminders: {},
    commitments: { c_alpha: commitmentAlphaShuffled(), c_beta: commitmentBeta() },
  };

  assert.equal(
    canonicalizeLifeStateInput(resolved(insertionOrderA)),
    canonicalizeLifeStateInput(resolved(insertionOrderB))
  );
  assert.equal(computeInputDigest(resolved(insertionOrderA)), computeInputDigest(resolved(insertionOrderB)));
});

test('naive JSON.stringify would not have caught the reordering the digest must survive', () => {
  // Guards the test above from becoming vacuous: if these two ever serialize
  // identically under JSON.stringify, the reorder fixtures stopped exercising
  // anything and the canonicalization test proves nothing.
  const a: DomainState = { commitments: { c_alpha: commitmentAlpha() }, reminders: {}, escalationStates: {} };
  const b: DomainState = { commitments: { c_alpha: commitmentAlphaShuffled() }, reminders: {}, escalationStates: {} };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

test('digest is a stable sha256 hex string for identical input', () => {
  const state: DomainState = { commitments: { c_alpha: commitmentAlpha() }, reminders: {}, escalationStates: {} };
  const first = computeInputDigest(resolved(state));
  const second = computeInputDigest(resolved(state));

  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('digest changes when any input value changes', () => {
  const base: DomainState = { commitments: { c_alpha: commitmentAlpha() }, reminders: {}, escalationStates: {} };
  const mutated: DomainState = {
    commitments: { c_alpha: { ...commitmentAlpha(), title: 'Alpha edited' } },
    reminders: {},
    escalationStates: {},
  };

  assert.notEqual(computeInputDigest(resolved(base)), computeInputDigest(resolved(mutated)));
  assert.notEqual(computeInputDigest(resolved(base)), computeInputDigest({ ...resolved(base), now: '2026-08-18T12:00:01.000Z' }));
  assert.notEqual(computeInputDigest(resolved(base)), computeInputDigest({ ...resolved(base), scopeId: 'scope-2' }));
  assert.notEqual(computeInputDigest(resolved(base)), computeInputDigest(resolved(base, 7)));
});

test('windowDays resolution defaults, floors, and rejects non-positive values', () => {
  assert.equal(resolveWindowDays(undefined), DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
  assert.equal(resolveWindowDays(7), 7);
  assert.equal(resolveWindowDays(7.9), 7);
  assert.equal(resolveWindowDays(0), DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
  assert.equal(resolveWindowDays(-3), DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
  assert.equal(resolveWindowDays(Number.NaN), DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
  assert.equal(resolveWindowDays(Number.POSITIVE_INFINITY), DEFAULT_RECENT_OUTCOMES_WINDOW_DAYS);
  // A fractional window under a day still has to mean at least one day, never zero.
  assert.equal(resolveWindowDays(0.5), 1);
});

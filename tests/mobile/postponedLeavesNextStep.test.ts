/**
 * «مش هلّق» takes the item off the next step until it comes back (CA2.1,
 * QA audit de7fcb8, confirmed on device).
 *
 * ── The defect ───────────────────────────────────────────────────
 *
 * Postpone sets `postponedUntil` and keeps `dueAt` (`stateMachine.ts`
 * Postpone). The next-step candidates read `dueAt` as the deadline and never
 * looked at `postponedUntil`, so a Must item due at 10:00, postponed at 11:00
 * «بعد ساعة», was still overdue — the strongest evidence the ranking has — and
 * came straight back as the next step right after «تمام. أجّلناها.».
 *
 * ── The rule ─────────────────────────────────────────────────────
 *
 * Postponed to a later instant, an item is not a step until that instant. At
 * and after it, it is a candidate again, exactly as before. The postpone is
 * applied through the shipped state machine, not hand-written into the state.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { selectNextStepForArmFromState } from '../../lib/experiments/nextStepArms.ts';

const TZ = 'Asia/Jerusalem';
/** Thursday 2026-11-12, 11:00 in Jerusalem (UTC+2 in November). */
const NOW = new Date('2026-11-12T09:00:00.000Z');
/** «بعد ساعة»: 12:00 local. */
const BACK_AT = '2026-11-12T10:00:00.000Z';

const MUST = { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } as const;
const SHOULD = { level: 'normal', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' } as const;

function commitment(id: string, dueAt: string, priority: Commitment['priority']): Commitment {
  return {
    id,
    kind: 'task',
    title: id,
    description: null,
    person: null,
    status: 'active',
    priority,
    category: null,
    categorySource: 'inferred',
    timeSpec: { kind: 'due_by', dueAt, endAt: null, remindAt: null, allDay: false, timezone: TZ },
    currentAckState: 'not_seen',
    postponedUntil: null,
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-01T08:00:00.000Z',
    confirmedAt: '2026-11-01T08:00:00.000Z',
    completedAt: null,
    droppedAt: null,
  } as Commitment;
}

function seeded(): DomainState {
  const state = createEmptyDomainState();
  // The Must item due 10:00 this morning: an hour late, the top step.
  state.commitments.report = commitment('report', '2026-11-12T08:00:00.000Z', MUST);
  // Something else to do later today.
  state.commitments.call = commitment('call', '2026-11-12T14:00:00.000Z', SHOULD);
  return state;
}

function postponed(): DomainState {
  return applyCommand(seeded(), {
    type: 'Postpone',
    commitmentId: 'report',
    postponedUntil: BACK_AT,
    now: NOW.toISOString(),
  }).newState;
}

function select(state: DomainState, now: Date) {
  return selectNextStepForArmFromState('generic', state, { now, locale: 'en', proposalId: 'p-postponed', timezone: TZ });
}

test('CA2.1 baseline: before the postpone the late Must item is the next step', () => {
  assert.equal(select(seeded(), NOW).selectedCommitmentId, 'report');
});

test('CA2.1: postponed «بعد ساعة», the item is not the next step until it comes back', () => {
  const state = postponed();
  // The postpone kept the deadline, as the device run saw.
  assert.equal(state.commitments.report!.timeSpec.dueAt, '2026-11-12T08:00:00.000Z');
  assert.equal(state.commitments.report!.postponedUntil, BACK_AT);
  const selection = select(state, NOW);
  assert.notEqual(selection.selectedCommitmentId, 'report', 'the postponed item came straight back as the next step');
  assert.equal(selection.scores.some((score) => score.commitmentId === 'report'), false, 'a postponed item is still a candidate');
  assert.equal(selection.selectedCommitmentId, 'call');
});

test('CA2.1: half an hour later it is still away', () => {
  assert.notEqual(select(postponed(), new Date('2026-11-12T09:30:00.000Z')).selectedCommitmentId, 'report');
});

test('CA2.1: at its return time it is a step again', () => {
  assert.equal(select(postponed(), new Date(BACK_AT)).selectedCommitmentId, 'report');
});

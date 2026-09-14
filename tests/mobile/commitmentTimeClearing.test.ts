/**
 * Removing a commitment's time (UC-2.R3, #173).
 *
 * The capture path has always let a user say "no time" — `validateEdit` reads
 * `resolvedTime: null` as a choice rather than a malformed field. A commitment
 * that already exists had no way to say it: `patchTimeSpec` ran every value
 * through `parseIsoInstant`, which refuses null, so the only expressible edits
 * were "move it" and "leave it alone".
 *
 * What is asserted here is the whole of the claim: the time goes, the
 * commitment becomes `unscheduled`, and the reminder that was standing is
 * cancelled rather than left pointing at an hour nothing will happen at.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCommand, createEmptyDomainState } from '../../src/domain/stateMachine.ts';
import type { Command, DomainState } from '../../src/domain/stateMachine.ts';
import { patchTimeSpecForTest } from '../../lib/services/mobile/commitmentService.ts';

/**
 * The clock supplied to `patchTimeSpec`, which refuses a time behind it (#352).
 * Injected rather than read, so `DUE` below stays a future time for good.
 */
const CLOCK = new Date('2026-11-01T09:00:00.000Z');
const TIMEZONE = 'Asia/Jerusalem';
const DUE = '2026-11-20T12:00:00.000Z';
const REMIND = '2026-11-20T10:00:00.000Z';

function timed() {
  return { kind: 'due_by' as const, dueAt: DUE, remindAt: REMIND, timezone: TIMEZONE };
}

test('null clears the due time, and is not the same as the field being absent', () => {
  // Absent: the patch did not touch the time, so nothing about it is returned.
  assert.equal(patchTimeSpecForTest(timed(), { title: 'A typo fixed' }, CLOCK), undefined);

  const cleared = patchTimeSpecForTest(timed(), { dueDate: null, reminderTime: null }, CLOCK);
  assert.equal(cleared?.dueAt, null);
  assert.equal(cleared?.remindAt, null);
  // A commitment with nothing to be due by is unscheduled, which is what the
  // lists read to decide it belongs on Today rather than on a later day.
  assert.equal(cleared?.kind, 'unscheduled');
  assert.equal(cleared?.timezone, TIMEZONE, 'the zone survives: it is the user’s, not the time’s');
});

test('clearing the reminder alone leaves the due time standing', () => {
  const patched = patchTimeSpecForTest(timed(), { reminderTime: null }, CLOCK);
  assert.equal(patched?.dueAt, DUE);
  assert.equal(patched?.remindAt, null);
  // Still a deadline, just an unreminded one.
  assert.equal(patched?.kind, 'due_by');
});

test('a move is still a move: null did not become the answer to everything', () => {
  const patched = patchTimeSpecForTest(timed(), { dueDate: '2026-11-22T12:00:00.000Z' }, CLOCK);
  assert.equal(patched?.dueAt, '2026-11-22T12:00:00.000Z');
  // The two-hour lead the user chose travels with it (UC-0.2c, #134).
  assert.equal(patched?.remindAt, '2026-11-22T10:00:00.000Z');
});

/**
 * The state machine's half of it.
 *
 * `patchTimeSpec` only decides the fields; whether a reminder is still pending
 * afterwards is `UpdateCommitment`'s doing, and that is the half a user would
 * actually notice — a phone that buzzes about a time they deleted.
 */
function withCommitment(): DomainState {
  const created = applyCommand(createEmptyDomainState(), {
    type: 'CreateDraft',
    now: '2026-11-01T09:00:00.000Z',
    commitment: {
      id: 'cmt_clear',
      kind: 'task',
      title: 'Hand in the report',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: timed(),
    },
    draftStatus: 'pending_confirmation',
  } as Command).newState;
  return applyCommand(created, {
    type: 'ConfirmCommitment',
    commitmentId: 'cmt_clear',
    now: '2026-11-01T09:01:00.000Z',
  } as Command).newState;
}

test('clearing the time cancels the reminder that was pending', () => {
  const before = withCommitment();
  const pending = Object.values(before.reminders).filter((reminder) => reminder.status === 'scheduled');
  assert.equal(pending.length, 1, 'the fixture must actually have a reminder to lose');

  const after = applyCommand(before, {
    type: 'UpdateCommitment',
    commitmentId: 'cmt_clear',
    now: '2026-11-02T09:00:00.000Z',
    updates: { timeSpec: patchTimeSpecForTest(timed(), { dueDate: null, reminderTime: null }, CLOCK) },
  } as Command).newState;

  assert.equal(after.commitments.cmt_clear!.timeSpec.kind, 'unscheduled');
  assert.equal(after.commitments.cmt_clear!.timeSpec.dueAt, null);
  assert.equal(after.commitments.cmt_clear!.timeSpec.remindAt, null);
  assert.equal(
    Object.values(after.reminders).some((reminder) => reminder.status === 'scheduled'),
    false,
    'a reminder for a time the user deleted is a phone that buzzes about nothing',
  );
});

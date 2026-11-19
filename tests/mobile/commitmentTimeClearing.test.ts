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
  return { kind: 'due_by' as const, dueAt: DUE, endAt: null, remindAt: REMIND, allDay: false, timezone: TIMEZONE };
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

/* ── QA v3 V3-F10-01: an event given its time back is still an event ── */

/**
 * The meeting at 17:00, edited in Details: its time cleared, then set again.
 * The owner's 2026-11-14 decision (a new title makes it `unsure`) stays; what
 * this holds is the plan's half — an event, or an `unsure` item whose title
 * names an event, given a time is a time to be at (`scheduled_event`), pinned
 * there by the planner, never a deadline it floats to 08:00.
 */
const MEETING_AT = '2026-11-20T15:00:00.000Z';
const MEETING = 'اجتماع مع فريق العمل والمدير';

function clearedEvent(itemKind: 'event' | 'unsure' | 'task') {
  return { kind: 'unscheduled' as const, dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: TIMEZONE, itemKind };
}

test('V3-F10-01: an event whose time was cleared and set again is a scheduled event, not a deadline', () => {
  const patched = patchTimeSpecForTest(clearedEvent('event'), { dueDate: MEETING_AT }, CLOCK, MEETING);
  assert.equal(patched?.kind, 'scheduled_event');
  assert.equal(patched?.dueAt, MEETING_AT);
  assert.equal(patched?.itemKind, 'event');
});

test('V3-F10-01: an unsure item (retitled, owner decision 2026-11-14) titled as a meeting keeps its hour too, and stays unsure', () => {
  const patched = patchTimeSpecForTest(clearedEvent('unsure'), { dueDate: MEETING_AT }, CLOCK, MEETING);
  assert.equal(patched?.kind, 'scheduled_event');
  assert.equal(patched?.itemKind, 'unsure', 'the owner\'s decision: the retitled item stays unsure');
});

test('V3-F10-01: a task given a time back is still a deadline, as before', () => {
  assert.equal(patchTimeSpecForTest(clearedEvent('task'), { dueDate: MEETING_AT }, CLOCK, MEETING)?.kind, 'due_by');
  assert.equal(patchTimeSpecForTest(clearedEvent('unsure'), { dueDate: MEETING_AT }, CLOCK, 'أبعت الملخص لسامي')?.kind, 'due_by');
  // A deadline moved stays a deadline, whatever its title.
  assert.equal(patchTimeSpecForTest({ ...timed(), itemKind: 'event' as const }, { dueDate: MEETING_AT }, CLOCK, MEETING)?.kind, 'due_by');
});

test('V3-F10-01: tomorrow\'s plan keeps the edited 17:00 meeting at 17:00, as a fixed row', async () => {
  const { buildDailyPlanInput } = await import('../../lib/services/dailyPlan/buildDailyPlan.ts');
  const base = {
    id: 'cmt_meeting', kind: 'task', title: MEETING, description: null, person: null, status: 'active',
    priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-11-19T06:00:00.000Z', updatedAt: '2026-11-19T06:00:00.000Z', confirmedAt: '2026-11-19T06:00:00.000Z',
    completedAt: null, droppedAt: null,
  };
  const plan = (timeSpec: object) => buildDailyPlanInput({
    uid: 'u', date: '2026-11-20', timezone: TIMEZONE, busyBlocks: [], profile: null, focusHint: null,
    builtAt: '2026-11-19T04:40:00.000Z',
    commitments: [{ ...base, timeSpec } as never],
  }).constraints;
  // Retitled only (owner decision): unsure, still pinned.
  const retitled = plan({ kind: 'scheduled_event', dueAt: MEETING_AT, endAt: null, remindAt: null, allDay: false, timezone: TIMEZONE, itemKind: 'unsure' });
  assert.deepEqual(retitled.items, []);
  assert.equal(retitled.fixedEvents[0]?.interval.startsAt, MEETING_AT);
  // Retitled, then its time cleared and set again.
  const reset = plan(patchTimeSpecForTest(clearedEvent('unsure'), { dueDate: MEETING_AT }, CLOCK, MEETING)!);
  assert.deepEqual(reset.items.map((item) => item.itemId), [], 'the meeting floated as a task the planner may put at 08:00');
  assert.equal(reset.fixedEvents[0]?.interval.startsAt, MEETING_AT);
});

test('V3-F10-01 through patchCommitment: retitle (unsure, owner decision), clear the time, set it again — still pinned at its hour', async () => {
  const { applyCommand: apply, configureCommandService } = await import('../../lib/services/commandService.ts');
  const { patchCommitment } = await import('../../lib/services/mobile/commitmentService.ts');
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  apply({
    type: 'CreateDraft',
    now: '2026-11-01T08:00:00.000Z',
    commitment: {
      id: 'cmt_meeting_e2e',
      kind: 'task',
      title: 'اجتماع مع فريق العمل',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'scheduled_event', dueAt: MEETING_AT, endAt: null, remindAt: null, allDay: false, timezone: TIMEZONE, itemKind: 'event' },
    },
    draftStatus: 'pending_confirmation',
  } as Command);
  apply({ type: 'ConfirmCommitment', commitmentId: 'cmt_meeting_e2e', now: '2026-11-01T08:01:00.000Z' } as Command);

  const retitled = await patchCommitment('cmt_meeting_e2e', { title: MEETING }, CLOCK);
  assert.equal(retitled.timeSpec.itemKind, 'unsure', 'the owner\'s 2026-11-14 decision');
  assert.equal(retitled.timeSpec.kind, 'scheduled_event');
  await patchCommitment('cmt_meeting_e2e', { dueDate: null, reminderTime: null }, CLOCK);
  const reset = await patchCommitment('cmt_meeting_e2e', { dueDate: MEETING_AT }, CLOCK);
  assert.equal(reset.timeSpec.kind, 'scheduled_event', 'the reset meeting came back a deadline');
  assert.equal(reset.timeSpec.itemKind, 'unsure');
});

test('V3-F10-01 review of #871: one PATCH that retitles an untimed meeting to a task and gives it a time makes a deadline, read from the new title', async () => {
  const { applyCommand: apply, configureCommandService } = await import('../../lib/services/commandService.ts');
  const { patchCommitment } = await import('../../lib/services/mobile/commitmentService.ts');
  configureCommandService({ initialState: createEmptyDomainState(), schedulerStore: null });
  apply({
    type: 'CreateDraft',
    now: '2026-11-01T08:00:00.000Z',
    commitment: {
      id: 'cmt_meeting_to_task',
      kind: 'task',
      title: 'اجتماع مع فريق العمل',
      priority: { level: 'normal', source: 'default', pressureAllowed: false, pressureLevel: 'none' },
      timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: TIMEZONE, itemKind: 'event' },
    },
    draftStatus: 'pending_confirmation',
  } as Command);
  apply({ type: 'ConfirmCommitment', commitmentId: 'cmt_meeting_to_task', now: '2026-11-01T08:01:00.000Z' } as Command);

  const patched = await patchCommitment('cmt_meeting_to_task', { title: 'أبعت الملخص لسامي', dueDate: MEETING_AT }, CLOCK);
  assert.equal(patched.timeSpec.itemKind, 'unsure', 'the owner\'s 2026-11-14 decision');
  assert.equal(patched.timeSpec.kind, 'due_by', 'a task title read as the old meeting');
});

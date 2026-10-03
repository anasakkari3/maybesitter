/**
 * «حضّرني» for tomorrow's exam plans the day before, not the hour before
 * (black-box audit 2026-10-03, #3; screen 23).
 *
 * The audit's account: on Saturday 3 October at 12:16 (Jerusalem), Details of
 * «عندي امتحان رياضيات بكرا الساعة 10» → «حضّرني» → one proposed session,
 * tomorrow 09:00, an hour before the exam, with the rest of Saturday free.
 *
 * The exam is captured and confirmed through the real capture pipeline; the
 * prep runs through `prepareMeeting` on the rule path (no model), with the
 * exam's commitment id as the phone now sends it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { prepareMeeting } from '../../lib/services/mobile/meetingPrepService.ts';
import { NO_QUIET_HOURS, type QuietHours } from '../../lib/push/quietHours.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import type { Commitment } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
const UID = 'prep-lead-user';
const AT_EXAM = new Date('2026-10-03T09:13:00.000Z'); // 12:13
const AT_PREP = new Date('2026-10-03T09:16:00.000Z'); // 12:16
const NOTES = 'امتحان رياضيات، بدي أراجع الجبر وأحل مسائل تدريبية';
const declined = async () => 'declined' as const;
const RINGS = { softEnabled: true, softLeadMinutes: 30, escalationCeiling: 'followUp' as const, surveySaysNone: false };

async function withMemoryStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  try {
    return await run();
  } finally {
    resetStorageForTests();
  }
}

async function capture(text: string, at: Date): Promise<void> {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: at.toISOString() }, { participantId: UID });
  const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: proposal.items.map((item) => item.itemId) }, { participantId: UID });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
}

async function exam(): Promise<Commitment> {
  await capture('عندي امتحان رياضيات بكرا الساعة 10', AT_EXAM);
  const state = await getParticipantStateSnapshot(UID);
  const found = Object.values(state.commitments).find((commitment) => commitment.title.includes('امتحان'));
  assert.ok(found);
  assert.equal(found.timeSpec.dueAt, '2026-10-04T07:00:00.000Z');
  return found;
}

function prepare(target: Commitment, now: Date, extra: { notes?: string; commitmentId?: string | null; quietHours?: QuietHours } = {}) {
  return prepareMeeting(UID, {
    notes: extra.notes ?? NOTES,
    startAt: target.timeSpec.dueAt,
    endAt: null,
    timezone: TZ,
    locale: 'ar',
    ...(extra.commitmentId === null ? {} : { commitmentId: extra.commitmentId ?? target.id }),
  }, { now, consent: declined, quietHours: extra.quietHours ?? NO_QUIET_HOURS, ringSettings: RINGS });
}

test('#3: tomorrow\'s exam is prepared for this afternoon, at the first free hour — and reviewed an hour before', async () => {
  await withMemoryStorage(async () => {
    const target = await exam();
    const { proposal, prep } = await prepare(target, AT_PREP);
    const [main, review] = proposal.items;
    // 13:00 on Saturday, not 09:00 on Sunday.
    assert.equal(main!.resolvedTime, '2026-10-03T10:00:00.000Z', `the session was at ${main!.resolvedTime}`);
    assert.equal(prep.timing, 'day_before');
    assert.ok(prep.leadMinutes >= 12 * 60, `lead ${prep.leadMinutes} min`);
    // The hour-before step stays, as a short review — two sessions.
    assert.equal(review!.resolvedTime, '2026-10-04T06:00:00.000Z');
    assert.match(review!.title, /^مراجعة سريعة: /);
    assert.deepEqual(prep.sessions.map((session) => session.at), [main!.resolvedTime, review!.resolvedTime]);
    assert.equal(prep.itemId, main!.itemId);
  });
});

test('#3: the session goes around what the person already has that afternoon', async () => {
  await withMemoryStorage(async () => {
    const target = await exam();
    await capture('عندي اجتماع مع سامي اليوم الساعة 1 الظهر', AT_EXAM);
    const { proposal } = await prepare(target, AT_PREP);
    assert.equal(proposal.items[0]!.resolvedTime, '2026-10-03T11:00:00.000Z', 'not over the 13:00 meeting');
  });
});

test('#3: never inside quiet hours — late at night, the day-before plan gives way to the hour before', async () => {
  await withMemoryStorage(async () => {
    const target = await exam();
    const quiet: QuietHours = { window: { start: '22:00', end: '07:00' }, timezone: TZ };
    const lateNight = new Date('2026-10-03T19:40:00.000Z'); // 22:40 — no room left on Saturday
    const { proposal, prep } = await prepare(target, lateNight, { quietHours: quiet });
    assert.equal(prep.timing, 'hour_before');
    assert.equal(proposal.items[0]!.resolvedTime, '2026-10-04T06:00:00.000Z');
  });
});

test('#3: the day-before session keeps out of quiet hours the person set inside the day', async () => {
  await withMemoryStorage(async () => {
    const target = await exam();
    // Quiet 12:00–15:30 on Saturday afternoon: the first free hour is 15:30.
    const quiet: QuietHours = { window: { start: '12:00', end: '15:30' }, timezone: TZ };
    const { proposal, prep } = await prepare(target, AT_PREP, { quietHours: quiet });
    assert.equal(prep.timing, 'day_before');
    assert.equal(proposal.items[0]!.resolvedTime, '2026-10-03T12:30:00.000Z', `the session was at ${proposal.items[0]!.resolvedTime}`);
  });
});

test('#3: the exam is known from the notes alone too, as an older phone sends no commitment id', async () => {
  await withMemoryStorage(async () => {
    const target = await exam();
    const { prep } = await prepare(target, AT_PREP, { commitmentId: null });
    assert.equal(prep.timing, 'day_before');
  });
});

test('#3: a meeting keeps its hour-before step, and one session', async () => {
  await withMemoryStorage(async () => {
    await capture('عندي اجتماع مع المدير بكرا الساعة 10', AT_EXAM);
    const state = await getParticipantStateSnapshot(UID);
    const meeting = Object.values(state.commitments).find((commitment) => commitment.title.includes('اجتماع'))!;
    const { proposal, prep } = await prepare(meeting, AT_PREP, { notes: 'اجتماع الميزانية، بدي أراجع الأرقام' });
    assert.equal(prep.timing, 'hour_before');
    assert.equal(prep.sessions.length, 1);
    assert.equal(proposal.items[0]!.resolvedTime, '2026-10-04T06:00:00.000Z');
  });
});

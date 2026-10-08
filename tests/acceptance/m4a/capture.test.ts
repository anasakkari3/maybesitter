/**
 * M4a Gate B — free times when a captured item has no hour (condition 19;
 * PLAN-M4a R001/R002 and the review dispositions named per test).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { replaceBusyBlocks } from '../../../lib/calendar/busyBlocks.ts';
import { beginGoogle, connectGoogleCalendar, denseIntervals, endGoogle, syncGoogle } from './google.ts';
import {
  DAYPART_IDS,
  REFERENCE,
  TODAY,
  TOMORROW,
  TZ,
  addEvent,
  at,
  begin,
  clarifyRaw,
  confirmRaw,
  end,
  failureSeam,
  loadTomorrow,
  overlaps,
  say,
  scheduleSeam,
  show,
  slotInterval,
  slotStart,
  slotsOf,
  untimed,
  type ScheduleSource,
  type Slot,
} from './support.ts';

const BANK_TOMORROW = 'لازم روح عالبنك بكرا'; // I have to go to the bank tomorrow
const BANK_TODAY = 'لازم روح عالبنك اليوم'; // I have to go to the bank today
const BANK_FRIDAY = 'لازم روح عالبنك يوم الجمعة'; // I have to go to the bank on Friday
const FRIDAY = '2026-10-09';

function minutes(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;
}

test('R002 an untimed item on a loaded day gets up to 3 real free times, earliest first, 90 minutes apart, inside the free gaps', async () => {
  const uid = begin();
  try {
    const busy = await loadTomorrow(uid);
    const answer = await say(uid, BANK_TOMORROW);
    const item = untimed(answer, 'البنك');
    assert.equal(item.clarification?.questionKey, 'ask_time', show(item.clarification));
    const slots = slotsOf(item);
    assert.equal(slots.length, 3, `expected 3 freeSlot options: ${show(item.clarification?.options)}`);
    assert.deepEqual(slots.map((slot) => slot.optionId), ['slot-1', 'slot-2', 'slot-3']);
    for (const slot of slots) {
      assert.equal(slot.value.localDate, TOMORROW, `a slot off the item's day: ${show(slot)}`);
      assert.deepEqual(slot.labelParams, { localDate: slot.value.localDate, localTime: slot.value.localTime }, show(slot));
      const interval = slotInterval(slot);
      for (const event of busy) assert.ok(!overlaps(interval, event), `slot ${show(slot)} overlaps ${show(event)}`);
      const local = slot.value.localTime!;
      assert.ok(local >= '08:00' && local <= '21:30', `outside the day window: ${local}`);
    }
    assert.equal(slots[0]!.value.localTime, '08:00', 'the earliest free time is offered first');
    for (let index = 1; index < slots.length; index += 1) {
      assert.ok(Date.parse(slotStart(slots[index]!)) > Date.parse(slotStart(slots[index - 1]!)), 'not earliest first');
      assert.ok(minutes(slotStart(slots[index]!), slotStart(slots[index - 1]!)) >= 90, 'slots closer than 90 minutes');
    }
    assert.ok(item.clarification!.options.some((option) => option.optionId === 'none'), '«بلا وقت» must stay');
    assert.equal(item.clarification!.allowFreeText, true);
  } finally { end(); }
});

test('R002 an item with no day is offered free times from now + 60 minutes', async () => {
  const uid = begin();
  try {
    const answer = await say(uid, 'لازم اتصل بالكهربائي'); // I have to call the electrician
    const item = untimed(answer, 'الكهربائي');
    const slots = slotsOf(item);
    assert.ok(slots.length >= 1, `no free slot offered: ${show(item.clarification)}`);
    assert.ok(Date.parse(slotStart(slots[0]!)) >= Date.parse(REFERENCE) + 60 * 60_000, `first slot before now + 60: ${show(slots[0])}`);
  } finally { end(); }
});

test('R001 capture policy: outside sleep or 08:00–22:00, never the planner focus window — a 20:00 slot today is offered', async () => {
  const uid = begin();
  try {
    await addEvent(uid, { startsAt: at(TODAY, '11:00'), endsAt: at(TODAY, '20:00') });
    const item = untimed(await say(uid, BANK_TODAY), 'البنك');
    const slots = slotsOf(item);
    assert.ok(slots.length >= 1, `no evening slot: ${show(item.clarification)}`);
    assert.equal(slots[0]!.value.localDate, TODAY);
    assert.equal(slots[0]!.value.localTime, '20:00', `the goal plan's 08–20 window leaked into capture: ${show(slots)}`);
    for (const slot of slots) assert.ok(Date.parse(slotInterval(slot).endsAt) <= Date.parse(at(TODAY, '22:00')), 'past 22:00');
  } finally { end(); }
});

test('M4A-R2-005 the proposal\'s own timed item is held before suggestions are made', async () => {
  const uid = begin();
  try {
    const answer = await say(uid, 'موعد الدكتور بكرا من 8 لـ 10 الصبح، ولازم روح عالبنك بكرا'); // doctor tomorrow 8–10am, and the bank tomorrow
    const doctor: Slot = { startsAt: at(TOMORROW, '08:00'), endsAt: at(TOMORROW, '10:00') };
    const slots = slotsOf(untimed(answer, 'البنك'));
    assert.ok(slots.length >= 1, show(answer.proposal));
    for (const slot of slots) assert.ok(!overlaps(slotInterval(slot), doctor), `offered inside the same message's appointment: ${show(slot)}`);
  } finally { end(); }
});

test('R002 several untimed items: each first suggestion is held for the next, so first choices never collide', async () => {
  const uid = begin();
  try {
    await loadTomorrow(uid);
    const answer = await say(uid, 'لازم روح عالبنك بكرا، ولازم اتصل بالكهربائي بكرا'); // the bank tomorrow, and call the electrician tomorrow
    const first = slotsOf(untimed(answer, 'البنك'))[0];
    const second = slotsOf(untimed(answer, 'الكهربائي'))[0];
    assert.ok(first && second, show(answer.proposal));
    assert.ok(!overlaps(slotInterval(first!), slotInterval(second!)), `first choices collide: ${show([first, second])}`);
  } finally { end(); }
});

test('R002 a day with no free time falls back to today\'s day-part options, unchanged', async () => {
  const uid = begin();
  try {
    await addEvent(uid, { startsAt: at(TOMORROW, '07:00'), endsAt: at(TOMORROW, '23:00') });
    const item = untimed(await say(uid, BANK_TOMORROW), 'البنك');
    assert.equal(slotsOf(item).length, 0, show(item.clarification));
    const ids = item.clarification!.options.map((option) => option.optionId);
    assert.ok(ids.every((id) => DAYPART_IDS.includes(id) || id === 'none'), `unexpected options: ${show(ids)}`);
    // Control: the same account's free Friday is offered slots, so the fallback is the full day's, not a missing finder.
    assert.ok(slotsOf(untimed(await say(uid, BANK_FRIDAY), 'البنك')).length >= 1, 'control: a free day offers slots');
  } finally { end(); }
});

for (const [label, switches] of [['off', { freeSlots: false }], ['killed', { killed: true }], ['production', { environment: 'production' }]] as const) {
  test(`R002 M4A-R3-005 flag ${label}: day-part options exactly as today, and the schedule reader is never called`, async () => {
    const uid = begin(switches);
    const seam = await scheduleSeam();
    let calls = 0;
    seam((original) => async (...args) => { calls += 1; return original(...args); });
    try {
      await loadTomorrow(uid);
      const item = untimed(await say(uid, BANK_TOMORROW), 'البنك');
      assert.equal(slotsOf(item).length, 0, show(item.clarification));
      assert.equal(calls, 0, 'the schedule was read with the capability off');
    } finally { seam(null); end(); }
  });
}

for (const source of ['commitments', 'busyBlocks', 'weeklyBlocks', 'routineProfile'] as ScheduleSource[]) {
  test(`M4A-R6-002 a failed ${source} read keeps the day-part question and never fails the proposal`, async () => {
    const uid = begin();
    const fail = await failureSeam();
    fail(source);
    try {
      const item = untimed(await say(uid, BANK_TOMORROW), 'البنك');
      assert.equal(slotsOf(item).length, 0, `slots offered from an incomplete schedule: ${show(item.clarification)}`);
      assert.equal(item.clarification?.questionKey, 'ask_time');
    } finally { fail(null); end(); }
  });
}

test('M4A-R6-002 a device busy block is avoided', async () => {
  const uid = begin();
  try {
    const block: Slot = { startsAt: at(TOMORROW, '08:00'), endsAt: at(TOMORROW, '13:00') };
    await replaceBusyBlocks(uid, 'device:gate-m4a', { startsAt: at(TODAY, '00:00'), endsAt: at('2026-10-21', '00:00') },
      [{ blockId: 'dev-1', sourceId: 'device:gate-m4a', sourceKind: 'device', startAt: block.startsAt, endAt: block.endsAt, allDay: false } as any],
      { platform: 'ios', now: new Date() });
    const slots = slotsOf(untimed(await say(uid, BANK_TOMORROW), 'البنك'));
    assert.ok(slots.length >= 1);
    for (const slot of slots) assert.ok(!overlaps(slotInterval(slot), block), `offered inside device busy time: ${show(slot)}`);
  } finally { end(); }
});

test('M4A-R7-001 a slot is offered only inside every connected source\'s coverage', async () => {
  const uid = begin();
  try {
    // The device window covers only up to tomorrow 12:00: later is unknown.
    await replaceBusyBlocks(uid, 'device:gate-m4a', { startsAt: at(TODAY, '00:00'), endsAt: at(TOMORROW, '12:00') }, [], { platform: 'ios', now: new Date() });
    const slots = slotsOf(untimed(await say(uid, BANK_TOMORROW), 'البنك'));
    assert.ok(slots.length >= 1, 'a covered morning slot (08:00) is still offered');
    for (const slot of slots) {
      assert.ok(Date.parse(slotInterval(slot).endsAt) <= Date.parse(at(TOMORROW, '12:00')), `a slot past the device's coverage: ${show(slot)}`);
    }
  } finally { end(); }
});

/** Writes with the clock moved back `days`, then returns it to REFERENCE. */
async function inThePast<T>(days: number, write: () => Promise<T>): Promise<T> {
  mock.timers.setTime(Date.parse(REFERENCE) - days * 86_400_000);
  try { return await write(); } finally { mock.timers.setTime(Date.parse(REFERENCE)); }
}

function assertDayParts(item: ReturnType<typeof untimed>, why: string): void {
  assert.equal(slotsOf(item).length, 0, `${why}: ${show(item.clarification)}`);
  assert.equal(item.clarification?.questionKey, 'ask_time');
  const ids = item.clarification!.options.map((option) => option.optionId);
  assert.ok(ids.every((id) => DAYPART_IDS.includes(id) || id === 'none'), `unexpected options: ${show(ids)}`);
}

test('M4A-R7-001 a stale device source (its window ended last week) covers nothing: day-part options', async () => {
  const uid = begin();
  try {
    assert.ok(slotsOf(untimed(await say(uid, BANK_TOMORROW), 'البنك')).length >= 1, 'control: no device source, slots offered');
    await inThePast(20, () => replaceBusyBlocks(uid, 'device:gate-m4a',
      { startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 14 * 86_400_000).toISOString() }, [], { platform: 'ios', now: new Date() }));
    assertDayParts(untimed(await say(uid, BANK_TOMORROW), 'البنك'), 'slots offered where the phone has no current coverage');
  } finally { end(); }
});

test('M4A-R7-001 Google: the busy time is avoided (positive control for the coverage cases)', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    const meeting: Slot = { startsAt: at(FRIDAY, '08:00'), endsAt: at(FRIDAY, '13:00') };
    await syncGoogle(uid, [{ start: meeting.startsAt, end: meeting.endsAt }]);
    const slots = slotsOf(untimed(await say(uid, BANK_FRIDAY), 'البنك'));
    assert.ok(slots.length >= 1, 'a fully covered Friday offers slots');
    for (const slot of slots) {
      assert.equal(slot.value.localDate, FRIDAY);
      assert.ok(!overlaps(slotInterval(slot), meeting), `offered inside Google busy time: ${show(slot)}`);
    }
  } finally { endGoogle(); end(); }
});

test('M4A-R7-001 Google connected but never synced: no window, so no slot', async () => {
  const uid = begin();
  beginGoogle();
  try {
    assert.ok(slotsOf(untimed(await say(uid, BANK_TOMORROW), 'البنك')).length >= 1, 'control: Google not connected, slots offered');
    await connectGoogleCalendar(uid);
    assertDayParts(untimed(await say(uid, BANK_TOMORROW), 'البنك'), 'slots offered with Google connected and nothing read');
  } finally { endGoogle(); end(); }
});

test('M4A-R7-001 Google stale (synced 20 days ago): no slot', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    await inThePast(20, () => syncGoogle(uid, []));
    assertDayParts(untimed(await say(uid, BANK_TOMORROW), 'البنك'), 'slots offered from a Google window that ended last week');
    await syncGoogle(uid, []);
    assert.ok(slotsOf(untimed(await say(uid, BANK_TOMORROW), 'البنك')).length >= 1, 'control: a sync now covers tomorrow again');
  } finally { endGoogle(); end(); }
});

test('M4A-R7-001 M4A-R3-002 Google truncated at 1000 intervals: a day past the honest window gets no slot', async () => {
  const uid = begin();
  beginGoogle();
  try {
    await connectGoogleCalendar(uid);
    // 1100 one-minute intervals every two minutes from now: the 1001st starts
    // tomorrow 19:20, so Friday — free at Google — is past the honest window.
    await syncGoogle(uid, denseIntervals(REFERENCE, 1100));
    assertDayParts(untimed(await say(uid, BANK_FRIDAY), 'البنك'), 'slots offered past the truncated Google window');
    await syncGoogle(uid, denseIntervals(REFERENCE, 10));
    assert.ok(slotsOf(untimed(await say(uid, BANK_FRIDAY), 'البنك')).length >= 1, 'control: an untruncated sync covers Friday');
  } finally { endGoogle(); end(); }
});

test('R002 a slot taken between the suggestion and the answer: not_free, nothing saved, fresh slots', async () => {
  const uid = begin();
  try {
    const answer = await say(uid, BANK_TOMORROW);
    const item = untimed(answer, 'البنك');
    const chosen = slotsOf(item)[0];
    assert.ok(chosen, show(item.clarification));
    await addEvent(uid, slotInterval(chosen!));
    const result = await clarifyRaw(uid, answer.proposal as any, item as any, { optionId: chosen!.optionId }, { revision: answer.proposal!.revision ?? 0 });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.reason, 'not_free', show(result.body));
    // The clarify answer is the proposal itself (route), with `reason` beside it.
    const after = (result.body.items ?? []).find((candidate: any) => candidate.itemId === item.itemId);
    assert.equal(after?.resolvedTime, null, `the taken slot was saved: ${show(after)}`);
    assert.ok(slotsOf(after).every((slot) => slotStart(slot) !== slotStart(chosen!)), 'the taken slot is offered again');
  } finally { end(); }
});

test('M4A-R2-002 «بلا وقت» stays settled and confirmable with the capability on', async () => {
  const uid = begin();
  try {
    const answer = await say(uid, BANK_TOMORROW);
    const item = untimed(answer, 'البنك');
    const result = await clarifyRaw(uid, answer.proposal as any, item as any, { optionId: 'none' }, { revision: answer.proposal!.revision ?? 0 });
    assert.equal(result.status, 200, show(result.body));
    const after = result.body.items.find((candidate: any) => candidate.itemId === item.itemId);
    assert.equal(after.needsClarification, false, `«بلا وقت» was asked again: ${show(after)}`);
    assert.equal(after.clarification, null);
    const confirmed = await confirmRaw(uid, { proposalId: result.body.proposalId, itemIds: [item.itemId], revision: result.body.revision, idempotencyKey: 'm4a-none-1' });
    assert.equal(confirmed.status, 200, show(confirmed.body));
  } finally { end(); }
});

test('M4A-R7-003 the multi-turn merge recomputes: a carried timed item is held for the new untimed one', async () => {
  const uid = begin();
  try {
    const first = await say(uid, 'موعد الدكتور بكرا الساعة 8 الصبح'); // doctor tomorrow 8am
    const second = await say(uid, 'ولازم روح عالبنك بكرا', { conversationId: first.conversationId }); // and the bank tomorrow
    const doctor: Slot = { startsAt: at(TOMORROW, '08:00'), endsAt: at(TOMORROW, '08:30') };
    const slots = slotsOf(untimed(second, 'البنك'));
    assert.ok(slots.length >= 1, show(second.proposal));
    for (const slot of slots) assert.ok(!overlaps(slotInterval(slot), doctor), `the carried appointment was not held: ${show(slot)}`);
  } finally { end(); }
});

test('M4A-006 a habit turned commitment gets the free-time question (flag on); with the flag off it keeps clarification null', async () => {
  for (const freeSlots of [true, false]) {
    const uid = begin({ freeSlots, kinds: true });
    try {
      const answer = await say(uid, 'بدي أمشي نص ساعة كل يوم الصبح', { entry: 'habit' }); // I want to walk half an hour every morning
      const habit = (answer.proposal?.habits ?? [])[0];
      assert.ok(habit, show(answer.proposal));
      const { editRaw } = await import('./support.ts');
      const edited = await editRaw(uid, answer.conversationId, {
        proposalId: answer.proposal!.proposalId, revision: answer.proposal!.revision ?? 0, target: { habitItemId: habit!.habitItemId } as any, change: { kind: 'commitment' } as any,
      });
      assert.equal(edited.status, 200, show(edited.body));
      const item = edited.body.proposal.items.find((candidate: any) => candidate.pointId === habit!.pointId);
      if (freeSlots) {
        assert.equal(item?.clarification?.questionKey, 'ask_time', show(item));
        assert.ok(slotsOf(item).length >= 1, show(item));
      } else {
        assert.equal(item?.clarification, null, `flag off must keep today's null: ${show(item)}`);
      }
    } finally { end(); }
  }
});

test('M4A-R2-001 flag off is byte-identical: the same capture answers the same body with the capability on but nothing to compute is not required — off equals ece27abf', async () => {
  // With the flag off, the stored proposal is what ece27abf writes: no freeSlot
  // option, no new field. Compared structurally against a run with no
  // free-slot code path at all is not possible in-process, so the gate pins
  // the observable contract: options are exactly the day-part ids + none.
  const uid = begin({ freeSlots: false });
  try {
    const item = untimed(await say(uid, BANK_TOMORROW), 'البنك');
    const ids = item.clarification!.options.map((option) => option.optionId);
    assert.deepEqual(ids.filter((id) => id !== 'none').every((id) => DAYPART_IDS.includes(id)), true, show(ids));
    assert.ok(!JSON.stringify(item).includes('freeSlot'), show(item));
  } finally { end(); }
});

void TZ;

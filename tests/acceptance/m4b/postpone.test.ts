/**
 * M4b Gate B — «أجّل» offers real free times, ranked, and picking one is the
 * only write (condition 26, owner decision D7; PLAN-M4b R3.1–R3.2, WIRE-M4b
 * "R3"). Memory storage, the clock pinned to Wednesday 2026-10-07 10:00
 * Jerusalem; no device source unless a test connects one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { applyParticipantCommands } from '../../../lib/services/mobile/participantState.ts';
import { userDoc } from '../../../lib/storage/paths.ts';
import {
  currentStorage,
  addAllDayEvent,
  addCommitment,
  addDeviceBusy,
  addEvent,
  addTimedDeadline,
  at,
  begin,
  call,
  commitment,
  end,
  grantPersonalization,
  localDateOf,
  localTimeOf,
  moveCommitment,
  overlaps,
  plusMinutes,
  postponeLegacy,
  raceAt,
  REFERENCE,
  show,
  TODAY,
  TOMORROW,
  TZ,
} from './support.ts';

test.afterEach(() => end());

const DAY = 24 * 3_600_000;
const WHYS = new Set(['soonest', 'light_day', 'usual_time']);

function dateAfter(days: number): string {
  return localDateOf(new Date(Date.parse(at(TODAY, '12:00')) + days * DAY).toISOString());
}

async function slotsFor(uid: string, id: string): Promise<{ complete: boolean; slots: any[] }> {
  const result = await call(uid, 'commitments/[id]/postpone-slots', 'GET', { params: { id } });
  assert.equal(result.status, 200, show(result.body));
  assert.equal(typeof result.body.complete, 'boolean', show(result.body));
  assert.ok(Array.isArray(result.body.slots), show(result.body));
  return result.body;
}

function pick(uid: string, id: string, slot: any, extra: Record<string, unknown> = {}) {
  return call(uid, 'commitments/[id]/actions', 'POST', { params: { id },
    body: { action: 'postpone', postponedUntil: slot.startsAt, fromSlot: true, slotToken: slot.slotToken, ...extra } });
}

function interval(slot: any) {
  return { startsAt: slot.startsAt, endsAt: slot.endsAt };
}

/* ── R3.1: the slots ────────────────────────────────────────────────── */

test('R3.1 D7: up to 3 real free times, each with a reason and a token, from now + 60 minutes', async () => {
  const uid = begin();
  const busy = { startsAt: at(TOMORROW, '08:00'), endsAt: at(TOMORROW, '12:00') };
  await addEvent(uid, 'شغل', busy.startsAt, busy.endsAt);
  const id = await addEvent(uid, 'مراجعة', at(TODAY, '15:00'), at(TODAY, '16:00')); // a review
  const { complete, slots } = await slotsFor(uid, id);
  assert.equal(complete, true);
  assert.ok(slots.length >= 1 && slots.length <= 3, show(slots));
  for (const slot of slots) {
    assert.ok(WHYS.has(slot.why), show(slot));
    assert.equal(typeof slot.slotToken, 'string');
    assert.ok(Date.parse(slot.startsAt) >= Date.parse(REFERENCE) + 60 * 60_000, `slot before now + 60: ${show(slot)}`);
    assert.equal(slot.localDate, localDateOf(slot.startsAt));
    assert.equal(slot.localTime, localTimeOf(slot.startsAt));
    assert.equal(Date.parse(slot.endsAt) - Date.parse(slot.startsAt), 60 * 60_000, 'the slot must keep the item\'s one-hour length');
    assert.ok(!overlaps(interval(slot), busy), `slot over busy time: ${show(slot)}`);
  }
});

test('R3.1: at most two slots on one local day', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'مراجعة', at(TODAY, '15:00'), at(TODAY, '15:30'));
  const { slots } = await slotsFor(uid, id);
  const perDay = new Map<string, number>();
  for (const slot of slots) perDay.set(slot.localDate, (perDay.get(slot.localDate) ?? 0) + 1);
  perDay.forEach((count, day) => assert.ok(count <= 2, `${count} slots on ${day}`));
});

test('R3.1 importance: a high-priority item is offered times within 3 days only', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'دفع الفاتورة', at(TODAY, '15:00'), at(TODAY, '15:30'), { priority: { level: 'high', source: 'user_explicit' } }); // pay the bill
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1);
  for (const slot of slots) assert.ok(Date.parse(slot.startsAt) <= Date.parse(REFERENCE) + 3 * DAY, `beyond 3 days for a high item: ${show(slot)}`);
});

test('R3.1 capacity: a day over 85 % occupied is not offered while lighter days exist', async () => {
  const uid = begin();
  await addEvent(uid, 'شغل', at(TOMORROW, '08:00'), at(TOMORROW, '20:30')); // 12.5 of 14 awake hours
  for (const day of [2, 3]) await addEvent(uid, 'شغل', at(dateAfter(day), '08:00'), at(dateAfter(day), '20:30'));
  const id = await addEvent(uid, 'مراجعة', at(TODAY, '15:00'), at(TODAY, '15:30'));
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1, show(slots));
  for (const slot of slots) assert.ok(![TOMORROW, dateAfter(2), dateAfter(3)].includes(slot.localDate), `a loaded day was offered: ${show(slot)}`);
});

test('M4B-R5-008: candidates span the whole horizon — a light day 6 wins over loaded earlier days', async () => {
  const uid = begin();
  for (const day of [1, 2, 3, 4, 5]) await addEvent(uid, 'شغل', at(dateAfter(day), '08:00'), at(dateAfter(day), '19:00'));
  await addEvent(uid, 'شغل', at(TODAY, '11:00'), at(TODAY, '22:00'));
  const id = await addEvent(uid, 'مراجعة', at(TODAY, '15:00'), at(TODAY, '15:30'));
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.some((slot) => slot.localDate === dateAfter(6) && slot.why === 'light_day'), `day 6 was never considered: ${show(slots)}`);
});

async function seedEveningHabit(uid: string): Promise<void> {
  // Eight «health» completions at ~18:30 local over the last 28 days.
  for (let index = 0; index < 8; index += 1) {
    const day = localDateOf(new Date(Date.parse(at(TODAY, '12:00')) - (3 + index * 3) * DAY).toISOString());
    const done = at(day, '18:30');
    const id = `0c0ffee6-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    await applyParticipantCommands(uid, [
      { type: 'CreateDraft', now: plusMinutes(done, -600), commitment: { id, kind: 'task', title: 'ركض', category: 'health', categorySource: 'user_explicit',
        timeSpec: { kind: 'due_by', dueAt: plusMinutes(done, 60), allDay: false, timezone: TZ } } } as any,
      { type: 'ConfirmCommitment', commitmentId: id, now: plusMinutes(done, -600) } as any,
      { type: 'Complete', commitmentId: id, now: done } as any,
    ]);
  }
}

test('R3.1 habit + M4B-R6-003: with consent, an evening usual time beats 08:00 on the same ordinary day', async () => {
  const uid = begin();
  await grantPersonalization(uid);
  await seedEveningHabit(uid);
  const id = await addEvent(uid, 'ركض', at(TODAY, '15:00'), at(TODAY, '15:30'), { category: 'health', categorySource: 'user_explicit' }); // a run
  const { slots } = await slotsFor(uid, id);
  const usual = slots.find((slot) => slot.why === 'usual_time');
  assert.ok(usual, `no usual_time slot with a clear evening habit and consent: ${show(slots)}`);
  assert.ok(usual.localTime >= '17:00' && usual.localTime <= '20:30', show(usual));
  assert.equal(slots[0].why, 'usual_time', `the habitual slot is not ranked first: ${show(slots)}`);
});

test('M4B-REV-005: without personalization consent no usual_time is ever returned', async () => {
  const uid = begin();
  await seedEveningHabit(uid);
  const id = await addEvent(uid, 'ركض', at(TODAY, '15:00'), at(TODAY, '15:30'), { category: 'health', categorySource: 'user_explicit' });
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1);
  assert.ok(slots.every((slot) => slot.why !== 'usual_time'), `behaviour-derived ranking without consent: ${show(slots)}`);
});

test('M4B-R4-001: a connected source covering only two days limits the slots to its window', async () => {
  const uid = begin();
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: at(dateAfter(2), '00:00') });
  const id = await addEvent(uid, 'مراجعة', at(TODAY, '15:00'), at(TODAY, '15:30'));
  const { slots } = await slotsFor(uid, id);
  for (const slot of slots) assert.ok(Date.parse(slot.endsAt) <= Date.parse(at(dateAfter(2), '00:00')), `an uncovered slot was offered: ${show(slot)}`);
});

test('M4B-R3-001: a two-hour event already postponed by the legacy action keeps two-hour slots', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TODAY, '13:00'), at(TODAY, '15:00')); // a workshop
  await postponeLegacy(uid, id, at(TODAY, '16:00'));
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1);
  for (const slot of slots) assert.equal(Date.parse(slot.endsAt) - Date.parse(slot.startsAt), 120 * 60_000, show(slot));
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 200, `a two-hour offer was refused: ${show(picked.body)}`);
});

/* ── R3.2: picking is the only write ────────────────────────────────── */

test('M4B-R2-003/R3-002: picking a slot for a timed event moves it whole and is still a postpone', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '12:00'));
  const { slots } = await slotsFor(uid, id);
  const slot = slots[0];
  const picked = await pick(uid, id, slot);
  assert.equal(picked.status, 200, show(picked.body));
  const stored = await commitment(uid, id);
  assert.equal(stored.timeSpec.dueAt, slot.startsAt, 'dueAt was not moved: readers that use dueAt still see the old time');
  assert.equal(stored.timeSpec.endAt, plusMinutes(slot.startsAt, 120), 'the length was not kept');
  assert.equal(stored.postponedUntil, slot.startsAt);
  assert.equal(stored.currentAckState, 'postponed');
  const state = await import('../../../lib/services/mobile/participantState.ts').then((m) => m.readParticipantState(uid));
  const reminders = Object.values((state as any).reminders as Record<string, any>).filter((r) => r.commitmentId === id && r.status === 'scheduled');
  assert.ok(reminders.some((r) => r.reminderType === 'check_in' && r.scheduledFor === slot.startsAt), `no return reminder at the slot: ${show(reminders)}`);
});

test('M4B-R5-005/R6-007: an end-less event is moved and keeps endAt null', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'طبيب الأسنان', at(TOMORROW, '08:00')); // the dentist, no end
  const { slots } = await slotsFor(uid, id);
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 200, show(picked.body));
  const stored = await commitment(uid, id);
  assert.equal(stored.timeSpec.dueAt, slots[0].startsAt);
  assert.ok(stored.timeSpec.endAt === null || stored.timeSpec.endAt === undefined, `an end was invented: ${show(stored.timeSpec)}`);
});

test('R3.2: a timed deadline picked from a slot keeps today\'s Postpone shape (dueAt untouched)', async () => {
  const uid = begin();
  const due = at(dateAfter(3), '17:00');
  const id = await addTimedDeadline(uid, 'سلّم التقرير', due);
  const { slots } = await slotsFor(uid, id);
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 200, show(picked.body));
  const stored = await commitment(uid, id);
  assert.equal(stored.timeSpec.dueAt, due);
  assert.equal(stored.postponedUntil, slots[0].startsAt);
});

test('M4B-R4-004: an all-day event uses the legacy postpone (its day boundaries stay)', async () => {
  const uid = begin();
  const id = await addAllDayEvent(uid, 'عيد ميلاد', TOMORROW); // a birthday
  const before = await commitment(uid, id);
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1, show(slots));
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 200, show(picked.body));
  const stored = await commitment(uid, id);
  assert.deepEqual(stored.timeSpec, before.timeSpec);
  assert.equal(stored.postponedUntil, slots[0].startsAt);
});

test('R3.2: a slot taken after the offer → 409 slot_taken with fresh slots, nothing moved', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '11:00'));
  const { slots } = await slotsFor(uid, id);
  await addEvent(uid, 'اجتماع', slots[0].startsAt, slots[0].endsAt);
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 409, show(picked.body));
  assert.equal(picked.body.error, 'slot_taken');
  assert.ok(Array.isArray(picked.body.slots));
  assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(TOMORROW, '10:00'));
});

test('M4B-R3-008: coverage lost after the offer → 409 slot_unverified, not slot_taken', async () => {
  const uid = begin();
  await addDeviceBusy(uid, []);
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '11:00'));
  const { slots } = await slotsFor(uid, id);
  await addDeviceBusy(uid, [], { startsAt: at(TODAY, '00:00'), endsAt: at(TODAY, '12:00') });
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 409, show(picked.body));
  assert.equal(picked.body.error, 'slot_unverified');
});

test('M4B-R4-003: the item changed after the offer → 409 slot_stale, nothing moved', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '10:30'));
  const { slots } = await slotsFor(uid, id);
  await moveCommitment(uid, id, at(TOMORROW, '10:00'), at(TOMORROW, '12:00')); // now two hours long
  const picked = await pick(uid, id, slots[0]);
  assert.equal(picked.status, 409, show(picked.body));
  assert.equal(picked.body.error, 'slot_stale');
  assert.equal((await commitment(uid, id)).timeSpec.dueAt, at(TOMORROW, '10:00'));
});

test('M4B-R5-006: a forged token, or one past its 15 minutes, → slot_stale', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '10:30'));
  const { slots } = await slotsFor(uid, id);
  const forged = await pick(uid, id, { ...slots[0], slotToken: 'x'.repeat(slots[0].slotToken.length) });
  assert.equal(forged.status, 409, show(forged.body));
  assert.equal(forged.body.error, 'slot_stale');
  mock.timers.tick(16 * 60_000);
  const expired = await pick(uid, id, slots[0]);
  assert.equal(expired.status, 409, show(expired.body));
  assert.equal(expired.body.error, 'slot_stale');
});

test('M4B-R6-005: a lost-response retry after the token expired replays the first success', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '10:30'));
  const { slots } = await slotsFor(uid, id);
  const key = '7a1e0000-0000-4000-8000-0000000000b1';
  const first = await pick(uid, id, slots[0], { clientActionId: key });
  assert.equal(first.status, 200, show(first.body));
  mock.timers.tick(16 * 60_000);
  const retry = await pick(uid, id, slots[0], { clientActionId: key });
  assert.equal(retry.status, 200, `a retry was judged against an expired token before its receipt: ${show(retry.body)}`);
  assert.equal(retry.body.replayed, true);
});

test('M4B-R3-003: the same clientActionId with and without fromSlot is a reused key', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '10:30'));
  const { slots } = await slotsFor(uid, id);
  const key = '7a1e0000-0000-4000-8000-0000000000b2';
  const plain = await call(uid, 'commitments/[id]/actions', 'POST', { params: { id }, body: { action: 'postpone', postponedUntil: slots[0].startsAt, clientActionId: key } });
  assert.equal(plain.status, 200, show(plain.body));
  const reused = await pick(uid, id, slots[0], { clientActionId: key });
  assert.equal(reused.status, 409, `fromSlot replayed a plain postpone: ${show(reused.body)}`);
  assert.equal(reused.body.reason, 'client_action_id_reused');
});

test('M4B-R2-004: a commitment confirmed into the slot mid-transaction → slot_taken', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '10:30'));
  const { slots } = await slotsFor(uid, id);
  const release = await raceAt('postpone', async () => { await addEvent(uid, 'زيارة', slots[0].startsAt, slots[0].endsAt); });
  let picked;
  try { picked = await pick(uid, id, slots[0]); } finally { release(); }
  assert.equal(picked.status, 409, show(picked.body));
  assert.equal(picked.body.error, 'slot_taken');
});

test('R3.2 parity: a plain postpone (no fromSlot) is unchanged', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '12:00'));
  const until = at(TOMORROW, '16:00');
  const plain = await call(uid, 'commitments/[id]/actions', 'POST', { params: { id }, body: { action: 'postpone', postponedUntil: until } });
  assert.equal(plain.status, 200, show(plain.body));
  const stored = await commitment(uid, id);
  assert.equal(stored.timeSpec.dueAt, at(TOMORROW, '10:00'));
  assert.equal(stored.timeSpec.endAt, at(TOMORROW, '12:00'));
  assert.equal(stored.postponedUntil, until);
});

/* ── release ────────────────────────────────────────────────────────── */

for (const [name, switches] of [['off', { postpone: false }], ['killed', { postponeKilled: true }], ['no key', { slotKey: null }], ['short key', { slotKey: 'too-short' }]] as const) {
  test(`R3 release (${name}): postpone-slots answers 404 feature_unavailable`, async () => {
    const uid = begin(switches);
    const id = await addEvent(uid, 'ورشة', at(TOMORROW, '10:00'), at(TOMORROW, '10:30'));
    const result = await call(uid, 'commitments/[id]/postpone-slots', 'GET', { params: { id } });
    assert.equal(result.status, 404, show(result.body));
    assert.equal(result.body.error, 'feature_unavailable');
  });
}

/* ── review findings (Claude's hand review of Task B) ───────────────── */

test('REVIEW B-2: an item stored in UTC (a feed deadline) gets slots in the account\'s own day and clock', async () => {
  const uid = begin();
  // The account's own zone, as the app records it on the user document.
  const storage = currentStorage() as any;
  const user = await storage.get(userDoc(uid));
  await storage.set(userDoc(uid), { ...(user ?? {}), timezone: TZ });
  const id = await addCommitment(uid, 'Essay due', { kind: 'due_by', dueAt: at(dateAfter(3), '17:00'), allDay: false, timezone: 'UTC' });
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1, show(slots));
  for (const slot of slots) {
    assert.equal(slot.localTime, localTimeOf(slot.startsAt), `localTime is not the account's clock: ${show(slot)}`);
    assert.equal(slot.localDate, localDateOf(slot.startsAt), show(slot));
    assert.ok(slot.localTime >= '08:00' && slot.localTime <= '21:30', `outside the account's awake window: ${show(slot)}`);
  }
});

test('REVIEW SIM-B1: a timed item is never offered its own current time or an earlier one', async () => {
  const uid = begin();
  const id = await addEvent(uid, 'ورشة تصميم', at(TODAY, '19:30'), at(TODAY, '20:00')); // a design workshop tonight
  const { slots } = await slotsFor(uid, id);
  assert.ok(slots.length >= 1, show(slots));
  for (const slot of slots) {
    assert.ok(Date.parse(slot.startsAt) > Date.parse(at(TODAY, '19:30')),
      `a "postpone" to the item's own time or earlier: ${show(slot)}`);
  }
});

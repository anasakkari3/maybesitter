/**
 * M4a Gate B — guards from Claude's hand review of Task B r1 (RB-1 … RB-5),
 * and one regression guard from the simulator pass (RB-6).
 *
 * RB-1 … RB-5 each fail on Task B r1 (`29315501`) for the defect they name;
 * RB-6 passes on r2 and pins the behaviour. Gate author: Claude.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { replaceBusyBlocks } from '../../../lib/calendar/busyBlocks.ts';
import { getStorage } from '../../../lib/storage/index.ts';
import { BUSY_BLOCKS, ICS_FEEDS, userCol, userSubDoc } from '../../../lib/storage/paths.ts';
import {
  DAYPART_IDS,
  REFERENCE,
  TODAY,
  TOMORROW,
  addEvent,
  at,
  begin,
  call,
  clarifyRaw,
  end,
  say,
  show,
  slotInterval,
  slotStart,
  slotsOf,
  untimed,
  type Item,
} from './support.ts';

const BANK_TOMORROW = 'لازم روح عالبنك بكرا'; // I have to go to the bank tomorrow
const DAY = 86_400_000;

async function icsFeed(uid: string, feedId: string, status: 'ok' | 'paused' | 'error'): Promise<void> {
  const now = new Date().toISOString();
  await getStorage().set(userSubDoc(uid, ICS_FEEDS, feedId), {
    feedId, label: null, encryptedUrl: { v: 1, keyName: 'test', ciphertext: 'x', iv: 'x', tag: 'x' } as any, hostHash: 'h',
    autoAcceptDeadlines: false, status, consecutiveFailures: status === 'ok' ? 0 : 5, lastErrorCode: status === 'error' ? 'timeout' : null,
    etag: null, lastModified: null, lastFetchedAt: now, lastFullFetchAt: now, lastManualRefreshAt: null,
    nextFetchAt: now, createdAt: now, busyBlocks: 0,
  });
}

/** The ICS writer's own window: from the refresh instant, 60 days ahead (`icsFeeds.ts` applyClassification). */
async function icsRefreshedNow(uid: string, feedId: string): Promise<void> {
  const now = Date.now();
  await replaceBusyBlocks(uid, `ics:${feedId}`, { startsAt: new Date(now).toISOString(), endsAt: new Date(now + 60 * DAY).toISOString() },
    [], { platform: null, now: new Date(now) });
}

function assertDayParts(item: Item, why: string): void {
  assert.equal(slotsOf(item).length, 0, `${why}: ${show(item.clarification)}`);
  const ids = item.clarification!.options.map((option) => option.optionId);
  assert.ok(ids.every((id) => DAYPART_IDS.includes(id) || id === 'none'), `${why}: ${show(ids)}`);
}

test('RB-1 PLAN R003 (M4A-R10-002, line 128): the capture finder treats a paused ICS feed as incomplete, as the app does', async () => {
  const uid = begin();
  try {
    await icsFeed(uid, 'feed1', 'ok');
    await icsRefreshedNow(uid, 'feed1');
    assert.ok(slotsOf(untimed(await say(uid, BANK_TOMORROW), 'البنك')).length >= 1, 'control: a healthy feed covers tomorrow');
    await icsFeed(uid, 'feed1', 'paused');
    assertDayParts(untimed(await say(uid, BANK_TOMORROW), 'البنك'), 'slots offered while an ICS feed is paused');
    await icsFeed(uid, 'feed1', 'error');
    assertDayParts(untimed(await say(uid, BANK_TOMORROW), 'البنك'), 'slots offered while an ICS feed is in error');
  } finally { end(); }
});

test('RB-2 WIRE "Server busy read": `complete` is about omitted blocks, not ICS windows — a feed refreshed now is complete', async () => {
  const uid = begin();
  try {
    await icsFeed(uid, 'feed1', 'ok');
    await icsRefreshedNow(uid, 'feed1');
    const result = await call(uid, 'calendar/busy', 'GET', { query: { from: at(TODAY, '00:00'), to: at('2026-11-04', '00:00') } });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.sources[0]?.status, 'ok', show(result.body.sources));
    assert.equal(result.body.complete, true, `every realistic ICS feed reads as incomplete: ${show(result.body)}`);
    assert.equal(result.body.cutoff, null);
  } finally { end(); }
});

test('RB-3 M4A-R15-001: a saturated in-window manual query is never complete, even when its rows start before `from`', async () => {
  const uid = begin();
  try {
    const from = at(TODAY, '00:00');
    const fromMs = Date.parse(from);
    const storage = getStorage();
    // 2001 valid, non-overlapping manual rows in [from − 13 h, from): they fill
    // the in-window query's 2001-row limit before any row inside the window.
    for (let index = 0; index < 2001; index += 1) {
      const start = fromMs - 13 * 3_600_000 + index * 10_000;
      await storage.set(`${userCol(uid, BUSY_BLOCKS)}/pre-${String(index).padStart(5, '0')}`, {
        blockId: `pre-${index}`, sourceId: 'manual-gate', sourceKind: 'manual',
        startAt: new Date(start).toISOString(), endAt: new Date(start + 5_000).toISOString(), allDay: false,
      });
    }
    await storage.set(`${userCol(uid, BUSY_BLOCKS)}/live`, {
      blockId: 'live', sourceId: 'manual-gate', sourceKind: 'manual',
      startAt: at(TOMORROW, '10:00'), endAt: at(TOMORROW, '11:00'), allDay: false,
    });
    const result = await call(uid, 'calendar/busy', 'GET', { query: { from, to: at('2026-11-04', '00:00') } });
    assert.equal(result.status, 200, show(result.body));
    const saw = (result.body.blocks as any[]).some((row) => row.blockId === 'live');
    assert.ok(saw || result.body.complete === false, `the live row was never read, and the answer claims completeness: ${show({ complete: result.body.complete, cutoff: result.body.cutoff, blocks: result.body.blocks.length })}`);
    if (!saw) assert.ok(result.body.cutoff !== null && Date.parse(result.body.cutoff) <= fromMs, `the cutoff must make the whole window unknown: ${result.body.cutoff}`);
  } finally { end(); }
});

test('RB-4 PLAN R002 (now + 60 minutes): a later answer recomputes slots from the request\'s time, not the proposal\'s creation', async () => {
  const uid = begin();
  try {
    const answer = await say(uid, 'لازم روح عالبنك اليوم، ولازم اتصل بالكهربائي اليوم'); // the bank today, and call the electrician today
    const bank = untimed(answer, 'البنك');
    const later = Date.parse(REFERENCE) + 5 * 3_600_000; // 15:00 local
    mock.timers.setTime(later);
    const result = await clarifyRaw(uid, answer.proposal as any, bank as any, { optionId: 'none' },
      { revision: answer.proposal!.revision ?? 0, referenceTime: new Date(later).toISOString() });
    assert.equal(result.status, 200, show(result.body));
    const electrician = (result.body.items as Item[]).find((item) => item.title.includes('الكهربائي'))!;
    for (const slot of slotsOf(electrician)) {
      assert.ok(Date.parse(slotStart(slot)) >= later + 60 * 60_000, `a slot before now + 60 minutes: ${show(slot)}`);
    }
  } finally { end(); }
});

test('RB-5 PLAN R002 fallback: not_free with no fresh slot returns the day-part question, never the old slots', async () => {
  const uid = begin();
  try {
    const answer = await say(uid, BANK_TOMORROW);
    const item = untimed(answer, 'البنك');
    const chosen = slotsOf(item)[0];
    assert.ok(chosen, show(item.clarification));
    // Tomorrow fills up entirely between the suggestion and the answer.
    await addEvent(uid, { startsAt: at(TOMORROW, '07:00'), endsAt: at(TOMORROW, '23:30') });
    const result = await clarifyRaw(uid, answer.proposal as any, item as any, { optionId: chosen!.optionId }, { revision: answer.proposal!.revision ?? 0 });
    assert.equal(result.status, 200, show(result.body));
    assert.equal(result.body.reason, 'not_free', show(result.body));
    const after = (result.body.items as Item[]).find((candidate) => candidate.itemId === item.itemId)!;
    assert.ok(!slotsOf(after).some((slot) => slotStart(slot) === slotStart(chosen!)), `the taken slot is offered again: ${show(after.clarification)}`);
    assertDayParts(after, 'old free slots kept instead of the day-part fallback');
    void slotInterval;
  } finally { end(); }
});

/*
 * ── RB-6, a regression guard from the simulator pass (2026-10-08) ─────
 *
 * Not a defect: on the device a week-2 habit read «خميس، جمعة، سبت · 08:00»,
 * which looked like this Friday's 08:00 appointment but meant next week's
 * days (the times stage names weekdays without their week — recorded for the
 * owner). This guard pins that a weekly time is free on every day it names
 * in its own window, before and after «غيّر كل الأوقات». It passes on r2.
 */

import { applyParticipantCommands } from '../../../lib/services/mobile/participantState.ts';
import {
  TODAY as M3A_TODAY,
  TZ as M3A_TZ,
  USER as M3A_USER,
  addDays,
  approve,
  at as m3aAt,
  call as m3aCall,
  draftOf,
  overlaps as m3aOverlaps,
  setup as m3aSetup,
  stepTimes,
  type ModelStep,
  type Times,
} from '../m3a/support.ts';

const GOAL = 'بدي أنزل بالوزن'; // I want to lose weight
function habitStep(title: string, extra: Partial<ModelStep> = {}): ModelStep {
  return { title, kind: 'habit', phase: { unit: 'week', index: 1 }, durationMinutes: 30, buildsOn: null, expectedOutcome: null,
    sourceSpans: [{ start: 0, end: GOAL.length, text: GOAL }], inferred: true, ...extra } as ModelStep;
}
function commitmentStep(title: string): ModelStep {
  return { title, kind: 'commitment', phase: { unit: 'week', index: 1 }, durationMinutes: 30, buildsOn: null, expectedOutcome: null,
    sourceSpans: [{ start: 0, end: GOAL.length, text: GOAL }], inferred: true } as ModelStep;
}

/** A scheduled event at 17:00 every day for two weeks; every other one has no end (the server's 30-minute rule). */
async function eveningEvents(): Promise<Array<{ startsAt: string; endsAt: string }>> {
  const now = new Date().toISOString();
  const busy: Array<{ startsAt: string; endsAt: string }> = [];
  const commands: any[] = [];
  for (let day = 0; day < 14; day += 1) {
    const date = addDays(M3A_TODAY, day);
    const startsAt = m3aAt(date, '17:00');
    const endless = day % 2 === 0;
    const endsAt = new Date(Date.parse(startsAt) + 30 * 60_000).toISOString();
    busy.push({ startsAt, endsAt });
    const id = `0c0ffee9-0000-4000-8000-${String(day + 1).padStart(12, '0')}`;
    commands.push(
      { type: 'CreateDraft', now, commitment: { id, kind: 'task', title: `review ${day}`,
        timeSpec: { kind: 'scheduled_event', dueAt: startsAt, endAt: endless ? null : endsAt, allDay: false, timezone: M3A_TZ } } },
      { type: 'ConfirmCommitment', commitmentId: id, now },
    );
  }
  await applyParticipantCommands(M3A_USER, commands);
  return busy;
}

/** Every date in the next 14 days that a weekly timing puts the habit on, as intervals. */
function weeklyIntervals(times: Times, stepId: string): Array<{ startsAt: string; endsAt: string }> {
  const entry = stepTimes(times, stepId) as any;
  const weekly = entry.weekly as { weekdays: number[]; start: string; end: string } | null;
  assert.ok(weekly, `the habit has no weekly time: ${JSON.stringify(entry)}`);
  const out: Array<{ startsAt: string; endsAt: string }> = [];
  for (let day = 0; day < 14; day += 1) {
    const date = addDays(M3A_TODAY, day);
    if (!weekly!.weekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue;
    const startsAt = m3aAt(date, weekly!.start);
    if (Date.parse(startsAt) < Date.now()) continue;
    out.push({ startsAt, endsAt: m3aAt(date, weekly!.end) });
  }
  return out;
}

for (const withBatch of [false, true]) {
  test(`RB-6 a weekly habit's offered time is free on every day it names${withBatch ? ', after «غيّر كل الأوقات» → evening' : ''}`, async () => {
    const h = await m3aSetup();
    try {
      const busy = await eveningEvents();
      h.answer({ horizon: 'weeks', steps: [
        commitmentStep('جهّز الأغراض'), // get things ready
        habitStep('رياضة', { rhythm: { timesPerWeek: 3, timeOfDay: 'evening' } } as any), // exercise
        commitmentStep('قيّم التقدّم'), // review progress
      ] });
      const { plan, times: initial } = await approve(h.goalId, await draftOf(h.goalId));
      let times = initial;
      if (withBatch) {
        const edited = await m3aCall('goals/[goalId]/plans/[planId]/times/batch', 'POST', { goalId: h.goalId, planId: times.planId },
          { timesId: times.timesId, timesRevision: times.timesRevision, preference: { partOfDay: 'evening' } });
        assert.equal(edited.status, 200, JSON.stringify(edited.body));
        times = edited.body.times as Times;
      }
      const habit = plan.steps.find((s: any) => s.kind === 'habit')!;
      for (const interval of weeklyIntervals(times, habit.stepId)) {
        for (const event of busy) {
          assert.ok(!m3aOverlaps(interval, event), `the habit is offered at ${interval.startsAt}, inside the 17:00 event ${event.startsAt}`);
        }
      }
    } finally { h.restore(); }
  });
}

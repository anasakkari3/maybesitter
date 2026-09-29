/**
 * A day with no hour is not late at its midnight (final UAT, N18).
 *
 * «عندي موعد دكتور اليوم» answered «بدون وقت محدد» is an all-day
 * `scheduled_event` on today (FY1): `dueAt` is today's local midnight and
 * `allDay` says nobody chose that hour. At 10:05 the next-step card made it the
 * top «خطوتك التالية» with the chip «الوقت راح», above lunch at 14:00: the
 * selector read the midnight as a deadline that had passed ten hours ago.
 *
 * The rule: an appointment on a day is not a work step. It happens on its day,
 * it is not the next thing to do, and it is never «الوقت راح» — not on its day
 * and not after it (then it is simply past, an event, not an overdue task).
 * And a *deadline* named as a day («لحد اليوم», answered «بدون وقت محدد») is
 * due by the end of that day, as the week has read it since N3, not by the
 * midnight that opens it.
 *
 * Every arm is driven, through `getLiveNextStep` — the function the route
 * calls — because the UAT server pinned `personalized` and the arms reorder
 * only what the baseline found eligible. Today's own list ranking
 * (`rankForMobile`, the fallback card's "why first" line) is held to the same
 * rule at the end.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clarifyMobileCapture, confirmMobileCapture, proposeMobileCapture } from '../../lib/services/mobile/mobileCaptureService.ts';
import { getParticipantStateSnapshot } from '../../lib/services/mobile/participantState.ts';
import { createMemoryStorage } from '../../lib/storage/memoryAdapter.ts';
import { resetStorageForTests, setStorageForTests } from '../../lib/storage/index.ts';
import { getLiveNextStep } from '../../lib/services/nextStepLiveService.ts';
import { candidatesFromDomainState, scoreBaselineCandidate } from '../../lib/services/nextStepBaseline.ts';
import { rankForMobile } from '../../lib/priority/mobileRanking.ts';
import { listTodayRanked, listUpcomingRanked } from '../../lib/services/mobile/commitmentService.ts';
import { NEXT_STEP_PINNED_ARM_ENV } from '../../lib/experiments/experimentControls.ts';
import { NEXT_STEP_ARMS } from '../../src/contracts/v1/experimentContracts.ts';
import { MODULE_FEATURE_FLAG_DEFAULTS, MODULE_KILL_SWITCH_DEFAULTS } from '../../src/contracts/v1/runtimeControls.ts';
import type { Commitment, DomainState } from '../../src/domain/stateMachine.ts';

const TZ = 'Asia/Jerusalem';
/** Monday 28 September 2026, 10:05 in Jerusalem: when the final UAT saw it. */
const NOW = new Date('2026-09-28T07:05:00.000Z');
/** Tuesday 29 September, 10:05: the day after. */
const TOMORROW = new Date('2026-09-29T07:05:00.000Z');
const UID = 'n18-user';

const controls = { version: 'v1' as const, featureFlags: { ...MODULE_FEATURE_FLAG_DEFAULTS, recommendation: true }, killSwitches: { ...MODULE_KILL_SWITCH_DEFAULTS } };

async function withMemoryStorage<T>(run: () => Promise<T>): Promise<T> {
  setStorageForTests(createMemoryStorage());
  try {
    return await run();
  } finally {
    resetStorageForTests();
  }
}

/** Capture one sentence as the phone does, answer «بدون وقت محدد» if asked, and confirm it. */
async function captureNoHour(text: string): Promise<void> {
  const proposal = await proposeMobileCapture({ text, timezone: TZ, referenceTime: NOW.toISOString() }, { participantId: UID });
  const item = proposal.items[0]!;
  if (item.clarification) {
    const none = item.clarification.options.find((option) => !option.value.localTime && !option.value.localDate);
    assert.ok(none, `${text}: no «بدون وقت محدد» option in ${JSON.stringify(item.clarification)}`);
    await clarifyMobileCapture({
      proposalId: proposal.proposalId, itemId: item.itemId, questionId: item.clarification.questionId, optionId: none.optionId,
      timezone: TZ, referenceTime: NOW.toISOString(),
    }, { participantId: UID });
  }
  const confirmed = await confirmMobileCapture({ proposalId: proposal.proposalId, itemIds: [item.itemId] }, { participantId: UID });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
}

function byTitle(state: DomainState, fragment: string): Commitment {
  const found = Object.values(state.commitments).find((commitment) => commitment.title.includes(fragment));
  assert.ok(found, `no commitment titled with «${fragment}» in ${JSON.stringify(Object.values(state.commitments).map((c) => c.title))}`);
  return found;
}

async function nextStepFor(state: DomainState, arm: string, now: Date) {
  return getLiveNextStep(state, {
    anonymousUserId: UID, consent: 'essential', locale: 'ar', now, controls, emitShown: false,
    emit: async () => undefined, timezone: TZ, env: { [NEXT_STEP_PINNED_ARM_ENV]: arm },
  } as never);
}

/** The UAT account's morning: the all-day doctor today and lunch at 14:00. */
async function uatMorning(): Promise<DomainState> {
  await captureNoHour('عندي موعد دكتور اليوم');
  await captureNoHour('لازم أحضّر الغداء اليوم الساعة 2 الظهر');
  return getParticipantStateSnapshot(UID);
}

test('N18: the saved state is the UAT one — an all-day event on today and lunch fixed at 14:00', async () => {
  await withMemoryStorage(async () => {
    const state = await uatMorning();
    const doctor = byTitle(state, 'موعد دكتور');
    assert.deepEqual([doctor.timeSpec.kind, doctor.timeSpec.allDay, doctor.timeSpec.dueAt], ['scheduled_event', true, '2026-09-27T21:00:00.000Z']);
    const lunch = byTitle(state, 'الغدا');
    assert.equal(lunch.timeSpec.dueAt, '2026-09-28T11:00:00.000Z');
  });
});

for (const arm of NEXT_STEP_ARMS) {
  test(`N18 (${arm}): at 10:05 lunch at 14:00 is the next step, and nothing says «الوقت راح»`, async () => {
    await withMemoryStorage(async () => {
      const state = await uatMorning();
      const doctor = byTitle(state, 'موعد دكتور');
      const lunch = byTitle(state, 'الغدا');
      const proposal = await nextStepFor(state, arm, NOW);
      assert.equal(proposal.state, 'ready');
      assert.equal(proposal.primaryStep?.commitmentId, lunch.id, `the next step was ${proposal.primaryStep?.title}`);
      assert.notEqual(proposal.primaryStep?.commitmentId, doctor.id);
      // The chips the phone renders are `explanation.evidenceCodes`.
      const codes = proposal.explanation!.evidenceCodes.map((entry) => entry.code);
      assert.ok(codes.length > 0, 'the card carries no reason at all');
      assert.ok(!codes.includes('overdue'), `«الوقت راح» on the card: ${codes.join(', ')}`);
    });
  });

  test(`N18 (${arm}): the all-day appointment alone is not a step on its day, nor «الوقت راح» after it`, async () => {
    await withMemoryStorage(async () => {
      await captureNoHour('عندي موعد دكتور اليوم');
      const state = await getParticipantStateSnapshot(UID);
      for (const at of [NOW, TOMORROW]) {
        const proposal = await nextStepFor(state, arm, at);
        assert.equal(proposal.primaryStep, null, `${at.toISOString()}: the appointment was offered as the next step`);
      }
    });
  });
}

test('N18: the all-day appointment is not a candidate at all — no «overdue» score on its day or after', async () => {
  await withMemoryStorage(async () => {
    const state = await uatMorning();
    const doctor = byTitle(state, 'موعد دكتور');
    const ids = candidatesFromDomainState(state).map((candidate) => candidate.commitmentId);
    assert.ok(!ids.includes(doctor.id), 'an appointment on a day was ranked as work');
    assert.equal(ids.length, 1);
  });
});

test('N18: a deadline named as a day is due by the end of that day, not its midnight', async () => {
  // «بدي أتصل بسامي اليوم» answered «بدون وقت محدد»: FX3/N3's all-day limit
  // on today. At 10:05 it is due within the day, not late; the next morning
  // it is late.
  await withMemoryStorage(async () => {
    await captureNoHour('بدي أتصل بسامي اليوم');
    const state = await getParticipantStateSnapshot(UID);
    const call = byTitle(state, 'سامي');
    assert.deepEqual([call.timeSpec.kind, call.timeSpec.allDay], ['due_by', true]);
    const [candidate] = candidatesFromDomainState(state);
    const codes = (at: Date) => scoreBaselineCandidate(candidate!, at).evidenceCodes.map((entry) => entry.code);
    assert.ok(!codes(NOW).includes('overdue'), `late at 10:05 on its own day: ${codes(NOW).join(', ')}`);
    assert.ok(codes(NOW).includes('due_within_24h'));
    // 23:59 on its day is still on time; 00:01 the next day is not.
    assert.ok(!codes(new Date('2026-09-28T20:59:00.000Z')).includes('overdue'));
    assert.ok(codes(new Date('2026-09-28T21:01:00.000Z')).includes('overdue'));
    assert.ok(codes(TOMORROW).includes('overdue'));
  });
});

/*
 * The same midnight on Today's own list (N18, the fallback card). With no
 * next step to show — the all-day appointment alone, now that it is no
 * candidate — Today falls back to the list's top item and prints its ranking
 * `reasonCodes` as the "why first" line: `overdue` is «الوقت مرق». The list
 * ranking reads the day the same way the selector now does.
 */
function codesOn(state: DomainState, id: string, at: Date): readonly string[] {
  const ranked = rankForMobile(Object.values(state.commitments), Object.values(state.reminders), at.toISOString());
  return ranked.find((entry) => entry.commitmentId === id)!.reasonCodes;
}

test('N18 (Today list): the all-day appointment is never «الوقت مرق» — on its day or after it', async () => {
  await withMemoryStorage(async () => {
    const state = await uatMorning();
    const doctor = byTitle(state, 'موعد دكتور');
    const lunch = byTitle(state, 'الغدا');
    assert.ok(!codesOn(state, doctor.id, NOW).includes('overdue'), `on its day: ${codesOn(state, doctor.id, NOW).join(', ')}`);
    assert.ok(!codesOn(state, doctor.id, TOMORROW).includes('overdue'), `after its day: ${codesOn(state, doctor.id, TOMORROW).join(', ')}`);
    // And it no longer sits above lunch at 14:00 as the late thing.
    const ranked = rankForMobile(Object.values(state.commitments), Object.values(state.reminders), NOW.toISOString());
    assert.equal(ranked[0]!.commitmentId, lunch.id);
  });
});

test('N18 (Today list): a deadline named as a day is «اليوم» on its day and late only after it', async () => {
  await withMemoryStorage(async () => {
    await captureNoHour('بدي أتصل بسامي اليوم');
    const state = await getParticipantStateSnapshot(UID);
    const call = byTitle(state, 'سامي');
    assert.ok(!codesOn(state, call.id, NOW).includes('overdue'), codesOn(state, call.id, NOW).join(', '));
    assert.ok(codesOn(state, call.id, NOW).includes('due_today'));
    assert.ok(codesOn(state, call.id, TOMORROW).includes('overdue'));
  });
});

test('N18 (Today list): the day after, yesterday\'s all-day appointment is not the late thing at the top', async () => {
  await withMemoryStorage(async () => {
    await captureNoHour('عندي موعد دكتور اليوم');
    await captureNoHour('بدي أتصل بسامي بكرا');
    const state = await getParticipantStateSnapshot(UID);
    const doctor = byTitle(state, 'موعد دكتور');
    const call = byTitle(state, 'سامي');
    const ranked = rankForMobile(Object.values(state.commitments), Object.values(state.reminders), TOMORROW.toISOString());
    assert.equal(ranked[0]!.commitmentId, call.id, `the top of Tuesday's list: ${ranked.map((entry) => entry.commitmentId === doctor.id ? 'doctor' : entry.commitmentId === call.id ? 'call' : '?').join(', ')}`);
    assert.deepEqual(ranked.find((entry) => entry.commitmentId === doctor.id)!.reasonCodes.filter((code) => code.startsWith('due') || code === 'overdue'), []);
  });
});

/* ── Review follow-ups (FINAL-BACKEND review, M1 and M4) ─────────────── */

const DEADLINE_CODES = ['overdue', 'due_within_2h', 'due_today', 'no_deadline'];
/** Monday 28 Sep, 22:30 in Jerusalem: inside the last two hours of the day. */
const MONDAY_LATE = new Date('2026-09-28T19:30:00.000Z');

test('M1: an all-day appointment carries no deadline chip on its day — not «اليوم», not «خلال ساعتين» at 22:30', async () => {
  await withMemoryStorage(async () => {
    const state = await uatMorning();
    const doctor = byTitle(state, 'موعد دكتور');
    for (const at of [NOW, MONDAY_LATE]) {
      const deadline = codesOn(state, doctor.id, at).filter((code) => DEADLINE_CODES.includes(code));
      assert.deepEqual(deadline, [], `${at.toISOString()}: ${codesOn(state, doctor.id, at).join(', ')}`);
    }
  });
});

test('M1: an all-day DEADLINE keeps its chips — «اليوم» at 10:05, «خلال ساعتين» at 22:30', async () => {
  await withMemoryStorage(async () => {
    await captureNoHour('بدي أتصل بسامي اليوم');
    const state = await getParticipantStateSnapshot(UID);
    const call = byTitle(state, 'سامي');
    assert.ok(codesOn(state, call.id, NOW).includes('due_today'), codesOn(state, call.id, NOW).join(', '));
    assert.ok(codesOn(state, call.id, MONDAY_LATE).includes('due_within_2h'), codesOn(state, call.id, MONDAY_LATE).join(', '));
  });
});

/*
 * M4: what happens to an event once it has passed. A timed event
 * (`scheduled_event` with an hour) is not taken off Today when its hour or
 * its day goes: #383 rolls every live commitment whose day is behind today
 * onto Today, and it stays there, active, until the person acts on it — the
 * product has no "overdue" and nothing auto-completes. The past all-day
 * appointment follows that exact rule: wherever the passed timed event is,
 * it is too, and it is still active.
 */
test('M4: a past all-day appointment is placed exactly as a passed timed event is — and neither is completed', async () => {
  await withMemoryStorage(async () => {
    await captureNoHour('عندي موعد دكتور اليوم');
    await captureNoHour('عندي اجتماع مع سامي اليوم الساعة 12 الظهر');
    const state = await getParticipantStateSnapshot(UID);
    const doctor = byTitle(state, 'موعد دكتور');
    const meeting = byTitle(state, 'اجتماع');
    assert.deepEqual([meeting.timeSpec.kind, meeting.timeSpec.allDay], ['scheduled_event', false]);
    const placement = async (id: string, at: Date) => {
      const today = (await listTodayRanked({ participantId: UID, now: at, timezone: TZ })).items.some((c) => c.id === id);
      const upcoming = (await listUpcomingRanked({ participantId: UID, now: at, timezone: TZ })).items.some((c) => c.id === id);
      return today ? 'today' : upcoming ? 'upcoming' : 'gone';
    };
    // Monday 22:30 (the meeting's hour gone), Tuesday, and a week on.
    for (const at of [MONDAY_LATE, TOMORROW, new Date('2026-10-05T07:05:00.000Z')]) {
      assert.equal(await placement(doctor.id, at), await placement(meeting.id, at), at.toISOString());
    }
    // The rule itself: the passed timed event is still on Today the next day.
    assert.equal(await placement(meeting.id, TOMORROW), 'today');
    const after = await getParticipantStateSnapshot(UID);
    assert.deepEqual([after.commitments[doctor.id]!.status, after.commitments[meeting.id]!.status], ['active', 'active']);
  });
});

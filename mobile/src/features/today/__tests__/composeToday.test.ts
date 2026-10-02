/**
 * Today's one answer (Round 2, Phase C).
 *
 * The screen used to draw three independent server results, each free to
 * name a different thing to do. These cases pin the reconciliation.
 */
import { describe, expect, it } from '@jest/globals';
import { composeToday, type NextStepInput, type PlanInput } from '../composeToday';
import { groupForToday, type CommitmentView, type TodayGroups } from '../../commitments/model';
import type { Commitment } from '../../../api/schemas/common';
import type { NextStepRecommendation } from '../../../api/schemas/nextStep';
import type { DailyPlan } from '../../../api/schemas/plan';

const item = (id: string, importance: CommitmentView['importance'] = 'should', status: CommitmentView['status'] = 'active'): CommitmentView => ({
  id, title: id, importance, status, shownAt: null, isPast: false, importanceIsStated: true, rank: undefined, reasonCodes: [],
});
const groups = (g: Partial<TodayGroups>): TodayGroups => ({ must: [], should: [], nice: [], finished: [], ...g });
const rec = (commitmentId: string, state = 'ready'): NextStepRecommendation => ({
  version: '1', proposalId: 'p1', state, locale: 'ar',
  primaryStep: state === 'ready' ? { commitmentId, title: commitmentId } : null,
  explanation: null, availableActions: ['accept'],
});
const next = (over: Partial<NextStepInput> = {}): NextStepInput => ({ recommendation: undefined, silenced: false, isPending: false, isError: false, ...over });
const plan = (over: Partial<PlanInput> = {}): PlanInput => ({ plan: undefined, isPending: false, isError: false, ...over });
const aPlan = (status: DailyPlan['status'], placed = 2): DailyPlan => ({
  date: '2026-09-22', timezone: 'Asia/Amman', status, generation: 1, inputDigest: 'x', generatedAt: '2026-09-22T04:00:00.000Z',
  acceptedAt: null, explanation: { text: '', locale: 'ar', source: 'template' },
  scheduled: Array.from({ length: placed }, (_, i) => ({ itemId: `i${i}`, title: null, startsAt: '2026-09-22T09:00:00.000Z', endsAt: '2026-09-22T10:00:00.000Z', blockId: null })),
  unscheduled: [], edited: false, protections: [],
});

describe('which quiet it is (UAT round 3, N12)', () => {
  const quiet = (over: Partial<NextStepInput>) =>
    composeToday({ groups: groups({ must: [item('a', 'must')] }), next: next({ silenced: true, ...over }), plan: plan(), upcoming: [] }).primary;

  it('quiet hours are not quiet mode, and say when they end', () => {
    expect(quiet({ silencedReason: 'quiet_hours', quietUntil: '07:30' })).toEqual({ kind: 'quiet', why: 'hours', until: '07:30' });
  });

  it('quiet hours from a server that sends no end are still quiet hours', () => {
    expect(quiet({ silencedReason: 'quiet_hours' })).toEqual({ kind: 'quiet', why: 'hours', until: null });
  });

  it('quiet mode is the person\'s switch, with no end', () => {
    expect(quiet({ silencedReason: 'quiet_mode', quietUntil: '07:30' })).toEqual({ kind: 'quiet', why: 'mode', until: null });
  });

  it('inside a weekly fixed block, says it is the block and when it ends (weekly blocks)', () => {
    expect(quiet({ silencedReason: 'weekly_block', quietUntil: '16:00' })).toEqual({ kind: 'quiet', why: 'block', until: '16:00' });
    expect(quiet({ silencedReason: 'weekly_block' })).toEqual({ kind: 'quiet', why: 'block', until: null });
  });

  it('a stop that is neither — the kill switch — is not called quiet mode', () => {
    expect(quiet({ silencedReason: 'kill_switch_active' })).toEqual({ kind: 'quiet', why: 'paused', until: null });
  });
});

describe('exactly one primary', () => {
  it('the recommendation wins, and its item leaves the list', () => {
    const m = composeToday({ groups: groups({ must: [item('a', 'must')], should: [item('b')] }), next: next({ recommendation: rec('b') }), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'next', item: { id: 'b' } });
    expect(m.groups.should).toHaveLength(0);
    expect(m.groups.must.map((c) => c.id)).toEqual(['a']);
    expect(m.openTotal).toBe(2);
    expect(m.openInGroups).toBe(1);
  });

  it('a recommendation for something not on the day is still the primary, and the list is whole', () => {
    const m = composeToday({ groups: groups({ must: [item('a', 'must')] }), next: next({ recommendation: rec('elsewhere') }), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'next', item: null });
    expect(m.groups.must).toHaveLength(1);
  });

  it("falls back to the list's own top item when there is no recommendation", () => {
    for (const n of [next(), next({ isError: true }), next({ isPending: true }), next({ recommendation: rec('x', 'empty') }), next({ recommendation: rec('x', 'insufficient_evidence') })]) {
      const m = composeToday({ groups: groups({ should: [item('b')], must: [item('a', 'must')] }), next: n, plan: plan(), upcoming: [] });
      expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'a' } });
      expect(m.groups.must).toHaveLength(0);
      expect(m.groups.should.map((c) => c.id)).toEqual(['b']);
    }
  });

  it('never lifts the fallback across the groups: the top Must beats an earlier Nice', () => {
    const m = composeToday({ groups: groups({ nice: [item('n', 'nice')], must: [item('m', 'must')] }), next: next(), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'm' } });
  });

  it('is "all done" once every open thing is resolved, whatever the route recommends', () => {
    const m = composeToday({ groups: groups({ finished: [item('a', 'must', 'done')] }), next: next({ recommendation: rec('tomorrow') }), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'allDone' });
    expect(m.isEmpty).toBe(false);
  });

  it('is quiet when the user asked for quiet, even with open items and a recommendation', () => {
    const m = composeToday({ groups: groups({ must: [item('a', 'must')] }), next: next({ recommendation: rec('a'), silenced: true, silencedReason: 'quiet_mode' }), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'quiet', why: 'mode', until: null });
    expect(m.groups.must).toHaveLength(1);
  });

  it('is nothing on a genuinely empty day', () => {
    const m = composeToday({ groups: groups({}), next: next(), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'none' });
    expect(m.isEmpty).toBe(true);
  });
});

describe('the plan row is honest', () => {
  it('says it is loading, failed, absent, proposed, accepted or dismissed — never nothing', () => {
    const g = groups({});
    expect(composeToday({ groups: g, next: next(), plan: plan({ isPending: true }), upcoming: [] }).plan).toEqual({ kind: 'loading' });
    expect(composeToday({ groups: g, next: next(), plan: plan({ isError: true, plan: null }), upcoming: [] }).plan).toEqual({ kind: 'error' });
    expect(composeToday({ groups: g, next: next(), plan: plan({ plan: null }), upcoming: [] }).plan).toEqual({ kind: 'none' });
    expect(composeToday({ groups: g, next: next(), plan: plan({ plan: aPlan('proposed', 3) }), upcoming: [] }).plan).toEqual({ kind: 'proposed', placed: 3 });
    expect(composeToday({ groups: g, next: next(), plan: plan({ plan: aPlan('edited', 1) }), upcoming: [] }).plan).toEqual({ kind: 'proposed', placed: 1 });
    expect(composeToday({ groups: g, next: next(), plan: plan({ plan: aPlan('accepted', 2) }), upcoming: [] }).plan).toEqual({ kind: 'accepted', placed: 2 });
    expect(composeToday({ groups: g, next: next(), plan: plan({ plan: aPlan('dismissed') }), upcoming: [] }).plan).toEqual({ kind: 'dismissed' });
  });

  /**
   * UAT round 6 N-h: «اليوم الساعة 8 المسا لازم أحضّر العشا» is pinned to
   * 20:00, so the plan lists it under `fixed`, never under `scheduled`. The
   * row counted `scheduled` alone and said «ما في إشي إله وقت اليوم» over an
   * accepted plan whose one row was that dinner.
   */
  it('counts what is pinned to a time, not only what the planner placed', () => {
    const dinner = { itemId: 'dinner', title: 'dinner', startsAt: '2026-09-22T17:00:00.000Z', endsAt: '2026-09-22T17:30:00.000Z', blockId: null };
    for (const status of ['accepted', 'proposed'] as const) {
      const m = composeToday({ groups: groups({}), next: next(), plan: plan({ plan: { ...aPlan(status, 0), fixed: [dinner] } }), upcoming: [] });
      expect(m.plan).toEqual({ kind: status, placed: 1 });
      expect(m.isEmpty).toBe(false);
    }
    const both = composeToday({ groups: groups({}), next: next(), plan: plan({ plan: { ...aPlan('accepted', 2), fixed: [dinner] } }), upcoming: [] });
    expect(both.plan).toEqual({ kind: 'accepted', placed: 3 });
  });

  it('a plan from a server that sends no `fixed` still counts what it placed', () => {
    const m = composeToday({ groups: groups({}), next: next(), plan: plan({ plan: aPlan('accepted', 0) }), upcoming: [] });
    expect(m.plan).toEqual({ kind: 'accepted', placed: 0 });
  });

  it('a refetch keeps the last plan rather than flashing a skeleton', () => {
    const m = composeToday({ groups: groups({}), next: next(), plan: plan({ isPending: true, plan: aPlan('accepted') }), upcoming: [] });
    expect(m.plan).toEqual({ kind: 'accepted', placed: 2 });
  });
});

describe('later', () => {
  it('shows the coming days without repeating the day or the primary, at most three', () => {
    const upcoming = [item('a'), item('u1'), item('u2', 'nice'), item('u3'), item('u4'), item('done', 'should', 'done')];
    const m = composeToday({ groups: groups({ must: [item('a', 'must')] }), next: next({ recommendation: rec('u1') }), plan: plan(), upcoming });
    expect(m.later.map((c) => c.id)).toEqual(['u2', 'u3', 'u4']);
  });
});

/**
 * F5 — the false empty state (Round 2 runtime verification, 2026-09-22).
 *
 * `isEmpty` used to be a predicate over the commitment list alone, so Today
 * drew «يومك فاضي» over a plan that had placed three things and over a
 * recommendation the server had just made. The screen's empty branch renders
 * *neither* the plan row nor the primary card, so both simply vanished.
 *
 * The contract is one sentence: the day is empty only when every source has
 * answered and none of them has anything to show.
 */
describe('the day is empty only when every source has answered with nothing', () => {
  const empty = groups({});

  it('is not empty when the plan placed something, even with no commitments on the list', () => {
    for (const status of ['proposed', 'accepted'] as const) {
      const m = composeToday({ groups: empty, next: next(), plan: plan({ plan: aPlan(status, 3) }), upcoming: [] });
      expect(m.plan).toMatchObject({ placed: 3 });
      expect(m.isEmpty).toBe(false);
    }
  });

  it('is not empty when the server recommended a step for something off the day', () => {
    const m = composeToday({ groups: empty, next: next({ recommendation: rec('elsewhere') }), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'next' });
    expect(m.isEmpty).toBe(false);
  });

  it('is not empty when the user asked for quiet: the quiet card is the content', () => {
    const m = composeToday({ groups: empty, next: next({ silenced: true, silencedReason: 'quiet_mode' }), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'quiet', why: 'mode', until: null });
    expect(m.isEmpty).toBe(false);
  });

  it('is not empty when there is nothing today but something later', () => {
    const m = composeToday({ groups: empty, next: next(), plan: plan(), upcoming: [item('u1')] });
    expect(m.later.map((c) => c.id)).toEqual(['u1']);
    expect(m.isEmpty).toBe(false);
  });

  it('does not claim the day is empty while a source is still answering', () => {
    expect(composeToday({ groups: empty, next: next(), plan: plan({ isPending: true }), upcoming: [] }).isEmpty).toBe(false);
    expect(composeToday({ groups: empty, next: next({ isPending: true }), plan: plan(), upcoming: [] }).isEmpty).toBe(false);
  });

  it('does not claim the day is empty when a source failed — the empty branch would hide the failure', () => {
    expect(composeToday({ groups: empty, next: next(), plan: plan({ isError: true, plan: null }), upcoming: [] }).isEmpty).toBe(false);
    expect(composeToday({ groups: empty, next: next({ isError: true }), plan: plan(), upcoming: [] }).isEmpty).toBe(false);
  });

  it('is still empty when the answers are all genuinely nothing', () => {
    for (const p of [plan(), plan({ plan: null }), plan({ plan: aPlan('dismissed', 0) }), plan({ plan: aPlan('proposed', 0) })]) {
      expect(composeToday({ groups: empty, next: next(), plan: p, upcoming: [] }).isEmpty).toBe(true);
    }
  });
});

/**
 * F5's own regression, found by running the app against the real backend
 * (2026-09-22).
 *
 * `/recommendations/next-step` answers **403 `consent_required`** for anybody
 * who has not turned recommendations on — which is every account by default.
 * The app maps that to `isError`, and treating an error as "we do not know
 * yet" meant Today could never call a day empty again: a signed-in user with
 * nothing on their day got a bare «ما في إشي» count line instead of the empty
 * state. Jest could not see it; the first real account did, immediately.
 *
 * A 403 is an answer. It says there is no recommendation for this account, as
 * definitely as `state: 'empty'` does. Only *not having answered* — still in
 * flight, or a failure that might not have happened — may hold the empty
 * state back.
 */
describe('a refusal is an answer, a failure is not', () => {
  const empty = groups({});

  it('is still empty when the recommendation route refuses by policy', () => {
    const m = composeToday({ groups: empty, next: next({ isError: true, unavailable: true }), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'none' });
    expect(m.isEmpty).toBe(true);
  });

  it('is not empty when the recommendation route actually failed', () => {
    expect(composeToday({ groups: empty, next: next({ isError: true }), plan: plan(), upcoming: [] }).isEmpty).toBe(false);
  });

  it('still holds back while the refusal has not arrived yet', () => {
    expect(composeToday({ groups: empty, next: next({ isPending: true, unavailable: true }), plan: plan(), upcoming: [] }).isEmpty).toBe(false);
  });

  it('a refusal does not change what is drawn: there is still no card to show', () => {
    const m = composeToday({ groups: groups({ must: [item('a', 'must')] }), next: next({ isError: true, unavailable: true }), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'a' } });
  });
});

/*
 * Final UAT, N18: «عندي موعد دكتور اليوم» answered «بدون وقت محدد» is an
 * all-day appointment (`scheduled_event`, `allDay`, due at today's local
 * midnight). At 10:05, with no recommendation to show, the list's own top item
 * became «خطوتك التالية» — and the only open item was the appointment. An
 * appointment on a day is not a step: it is on Today as context, in its group,
 * and the card goes to the first thing that is one (the server leaves it out of
 * the next-step candidates for the same reason, FINAL-BACKEND d2762718).
 */
describe('an all-day appointment is never the step (N18)', () => {
  const NOW = '2026-09-28T07:05:00.000Z'; // 10:05 in Amman
  const base = {
    kind: 'task', description: null, person: null, status: 'active',
    currentAckState: 'not_seen', postponedUntil: null,
    createdAt: '2026-09-28T07:00:00.000Z', updatedAt: '2026-09-28T07:00:00.000Z', confirmedAt: '2026-09-28T07:00:00.000Z',
    completedAt: null, droppedAt: null,
  };
  const doctor = {
    ...base, id: 'doctor', title: 'عندي موعد دكتور',
    priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'scheduled_event', dueAt: '2026-09-27T21:00:00.000Z', endAt: null, remindAt: null, allDay: true, timezone: 'Asia/Amman' },
  } as unknown as Commitment;
  const lunch = {
    ...base, id: 'lunch', title: 'أحضّر الغداء',
    priority: { level: 'high', source: 'inferred', pressureAllowed: false, pressureLevel: 'none' },
    timeSpec: { kind: 'scheduled_event', dueAt: '2026-09-28T11:00:00.000Z', endAt: '2026-09-28T11:30:00.000Z', remindAt: null, allDay: false, timezone: 'Asia/Amman' },
  } as unknown as Commitment;

  it('the literal case: the appointment alone is context, not the card, and the day is not empty', () => {
    const m = composeToday({ groups: groupForToday([doctor], NOW), next: next(), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'none' });
    expect(m.groups.must.map((c) => c.id)).toEqual(['doctor']);
    expect(m.openTotal).toBe(1);
    expect(m.isEmpty).toBe(false);
  });

  it('with lunch at 14:00 on the day, lunch is the step and the appointment stays in its group', () => {
    const m = composeToday({ groups: groupForToday([doctor, lunch], NOW), next: next(), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'lunch' } });
    expect(m.groups.must.map((c) => c.id)).toEqual(['doctor']);
  });

  it('an all-day *task* — a thing to do by the end of the day — is still a step', () => {
    const bill = { ...doctor, id: 'bill', timeSpec: { ...doctor.timeSpec, kind: 'due_by' } } as Commitment;
    const m = composeToday({ groups: groupForToday([bill], NOW), next: next(), plan: plan(), upcoming: [] });
    expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'bill' } });
  });
});

/**
 * Audit 2026-10-03 #2: «سهرة مع الصحاب الليلة 21:00» was «خطوتك التالية» at
 * 12:22. With no recommendation to show, the fallback must not make the same
 * mistake: an event at an hour is the card only in its last hour.
 */
describe('an event at an hour, on the fallback card', () => {
  const NOW = new Date('2026-10-03T09:22:00.000Z');
  const event = (id: string, at: string): CommitmentView => ({ ...item(id, 'must'), shownAt: at, timedEvent: true });

  it('is not the card nine hours before it starts — the next thing to do is', () => {
    const m = composeToday({
      groups: groups({ must: [event('night-out', '2026-10-03T18:00:00.000Z')], should: [item('call')] }),
      next: next({ recommendation: rec('', 'empty') }), plan: plan(), upcoming: [], now: NOW,
    });
    expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'call' } });
  });

  it('is no card at all when it is all the day has', () => {
    const m = composeToday({
      groups: groups({ must: [event('night-out', '2026-10-03T18:00:00.000Z')] }),
      next: next({ recommendation: rec('', 'empty') }), plan: plan(), upcoming: [], now: NOW,
    });
    expect(m.primary).toEqual({ kind: 'none' });
    expect(m.groups.must.map((c) => c.id)).toEqual(['night-out']);
  });

  it('is the card in its last hour', () => {
    const m = composeToday({
      groups: groups({ must: [event('night-out', '2026-10-03T18:00:00.000Z')] }),
      next: next({ recommendation: rec('', 'empty') }), plan: plan(), upcoming: [], now: new Date('2026-10-03T17:15:00.000Z'),
    });
    expect(m.primary).toMatchObject({ kind: 'fallback', item: { id: 'night-out' } });
  });
});

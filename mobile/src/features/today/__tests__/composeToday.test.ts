/**
 * Today's one answer (Round 2, Phase C).
 *
 * The screen used to draw three independent server results, each free to
 * name a different thing to do. These cases pin the reconciliation.
 */
import { describe, expect, it } from '@jest/globals';
import { composeToday, type NextStepInput, type PlanInput } from '../composeToday';
import type { CommitmentView, TodayGroups } from '../../commitments/model';
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
  scheduled: Array.from({ length: placed }, (_, i) => ({ itemId: `i${i}`, title: null, startsAt: '2026-09-22T09:00:00.000Z', endsAt: '2026-09-22T10:00:00.000Z' })),
  unscheduled: [], edited: false,
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
    const m = composeToday({ groups: groups({ must: [item('a', 'must')] }), next: next({ recommendation: rec('a'), silenced: true }), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'quiet' });
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
    const m = composeToday({ groups: empty, next: next({ silenced: true }), plan: plan(), upcoming: [] });
    expect(m.primary).toEqual({ kind: 'quiet' });
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

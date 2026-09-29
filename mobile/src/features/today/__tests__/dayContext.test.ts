import { dayProgress, importantDeadline, planPreview } from '../dayContext';
import type { Commitment } from '../../../api/schemas/common';
import type { DailyPlan } from '../../../api/schemas/plan';
import { describe, expect, it } from '@jest/globals';
import capture from '../../../api/__fixtures__/commitments.one.json';

const date = '2026-09-23';
const zone = 'Asia/Hebron';
const seed = capture as Commitment;
const item = (id: string, overrides: Partial<Commitment> = {}): Commitment => ({
  ...seed, id, title: id, status: 'active', completedAt: null,
  priority: { ...seed.priority, level: 'high', source: 'user_explicit' },
  timeSpec: { ...seed.timeSpec, kind: 'due_by', dueAt: '2026-09-23T22:00:00.000Z' }, ...overrides,
});
const plan = (status: DailyPlan['status'] = 'accepted'): DailyPlan => ({
  date, timezone: zone, status, generation: 1, inputDigest: '', generatedAt: '2026-09-23T00:00:00Z', acceptedAt: null,
  explanation: { text: '', locale: 'en', source: 'template' }, edited: false, unscheduled: [],
  scheduled: ['done', 'next', 'later', 'fourth', 'fifth'].map((itemId, i) => ({ itemId, title: itemId, startsAt: `2026-09-23T0${i + 4}:00:00Z`, endsAt: `2026-09-23T0${i + 4}:30:00Z`, blockId: null })),
  protections: [],
});
const records = ['done', 'next', 'later', 'fourth', 'fifth'].map(id => item(id, id === 'done' ? { status: 'completed' } : {}));

describe('grounded plan preview', () => {
  it('uses current records, orders slots and limits the preview without guessing current activity', () => {
    const p = plan(); p.scheduled.reverse();
    const preview = planPreview(p, records);
    expect(preview.map(row => [row.id, row.state])).toEqual([['done', 'done'], ['next', 'next'], ['later', 'planned'], ['fourth', 'planned']]);
  });
  it.each(['proposed', 'edited'] as const)('%s never becomes an accepted next action', status => {
    expect(planPreview(plan(status), records).map(row => row.state)).toEqual(['done', 'proposed', 'proposed', 'proposed']);
  });
  it('omits dismissed plans, deleted/missing records and dropped commitments', () => {
    expect(planPreview(plan('dismissed'), records)).toEqual([]);
    expect(planPreview(plan(), [item('next', { status: 'dropped' }), item('later')])).toMatchObject([{ id: 'later', state: 'next' }]);
  });
  it('never repeats a slot or uses its stale title', () => {
    const p = plan(); p.scheduled.unshift(p.scheduled[1]!);
    const preview = planPreview(p, [item('next', { title: 'Updated' })]);
    expect(preview).toHaveLength(1); expect(preview[0]?.title).toBe('Updated');
  });
});

/**
 * UAT round 6 N-h: a commitment pinned to a time (`fixed`) is on the plan as
 * much as a placed one — the plan screen draws it between the placed rows —
 * so the Today card previews it too, in time order.
 */
describe('the preview includes what is pinned to a time', () => {
  const dinnerSlot = { itemId: 'dinner', title: 'dinner', startsAt: '2026-09-23T17:00:00Z', endsAt: '2026-09-23T17:30:00Z', blockId: null };
  const withDinner = (status: DailyPlan['status'] = 'accepted'): DailyPlan => ({ ...plan(status), scheduled: [], fixed: [dinnerSlot] });

  it('a plan whose only row is a fixed one previews that row', () => {
    expect(planPreview(withDinner(), [item('dinner')]).map(row => [row.id, row.startsAt, row.state]))
      .toEqual([['dinner', '2026-09-23T17:00:00Z', 'next']]);
    expect(planPreview(withDinner('proposed'), [item('dinner')]).map(row => row.state)).toEqual(['proposed']);
  });

  it('interleaves fixed rows with placed ones by time', () => {
    const p: DailyPlan = { ...plan(), fixed: [{ ...dinnerSlot, startsAt: '2026-09-23T05:10:00Z', endsAt: '2026-09-23T05:20:00Z' }] };
    expect(planPreview(p, [...records, item('dinner')]).map(row => row.id)).toEqual(['done', 'next', 'dinner', 'later']);
  });

  /**
   * The card at two times of the same day. «Next in plan» on a slot that has
   * already ended is a claim about the past; it stays on the plan, it is just
   * not what comes next.
   */
  it('names as next the first open row that has not ended, and none once they all have', () => {
    const p: DailyPlan = { ...plan(), fixed: [dinnerSlot] };
    const all = [...records, item('dinner')];
    const states = (now: string) => planPreview(p, all, new Date(now)).map(row => [row.id, row.state]);
    // Morning, before anything: the first open row is next.
    expect(states('2026-09-23T03:00:00Z')).toEqual([['done', 'done'], ['next', 'next'], ['later', 'planned'], ['fourth', 'planned']]);
    // Mid-morning, two slots over: the next one that has not ended is next.
    expect(states('2026-09-23T06:45:00Z')).toEqual([['done', 'done'], ['next', 'planned'], ['later', 'planned'], ['fourth', 'next']]);
    // Late evening, every slot (dinner at 17:00Z included) over: nothing is next.
    expect(states('2026-09-23T20:00:00Z').map(([, state]) => state)).not.toContain('next');
  });
});

describe('honest daily progress', () => {
  it('counts local-day completions, excluding drops and completions on another day', () => {
    const completed = item('completed', { status: 'completed', completedAt: '2026-09-22T22:00:00Z' });
    expect(dayProgress([completed, completed, item('open'), item('dropped', { status: 'dropped' }), item('old', { status: 'completed', completedAt: '2026-09-22T10:00:00Z' })], date, zone)).toEqual({ done: 1, total: 2 });
    expect(dayProgress([completed, item('open')], date, 'UTC')).toBeNull();
  });
  it('omits a zero-progress or single-item metric', () => {
    expect(dayProgress([item('open')], date, zone)).toBeNull();
    expect(dayProgress([item('done', { status: 'completed', completedAt: '2026-09-23T00:00:00Z' })], date, zone)).toBeNull();
  });
});

describe('one evidenced deadline', () => {
  it('uses local day keys and an explicit high priority', () => {
    const deadline = item('deadline');
    expect(importantDeadline([deadline], ['2026-09-24'], zone)?.id).toBe('deadline');
    expect(importantDeadline([deadline], ['2026-09-23'], zone)).toBeNull();
  });
  it('does not turn inferred priority, a reminder, an event, or a finished item into a deadline', () => {
    const deadline = item('deadline');
    for (const changed of [
      { priority: { ...deadline.priority, source: 'inferred' } },
      { timeSpec: { ...deadline.timeSpec, kind: 'scheduled_event' as const } },
      { timeSpec: { ...deadline.timeSpec, dueAt: null, remindAt: deadline.timeSpec.dueAt } },
      { status: 'completed' }, { status: 'cancelled' },
    ]) expect(importantDeadline([{ ...deadline, ...changed }], ['2026-09-24'], zone)).toBeNull();
  });
  it('chooses one earliest deadline, never extrapolates outside queried days', () => {
    expect(importantDeadline([item('later', { timeSpec: { ...seed.timeSpec, kind: 'due_by', dueAt: '2026-09-24T10:00:00Z' } }), item('first')], ['2026-09-24'], zone)?.id).toBe('first');
    expect(importantDeadline([item('first')], [], zone)).toBeNull();
  });
});

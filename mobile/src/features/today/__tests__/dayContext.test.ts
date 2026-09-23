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

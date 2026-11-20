/**
 * Which habits Today shows, and in what order (QA v3 V3-F23-06, owner
 * decision 2026-11-20): a quiet row per habit occurrence today asks for —
 * never an off day a weekly count merely allows, never a paused habit — in
 * the order of the hour each prefers, the ones with no hour after.
 */
import { describe, expect, it } from '@jest/globals';
import { todayHabitRows } from '../todayHabits';
import type { Habit, HabitOccurrence, HabitToday } from '../../../api/schemas/habits';

const DAY = '2026-11-20';

function habit(habitId: string, overrides: Partial<Habit> = {}): Habit {
  return {
    habitId, title: habitId, cadence: { kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30,
    preferredWindows: [], minimumOccurrences: 7, maximumOccurrences: 7, flexibility: 'protected_flexible', recoveryPolicy: 'skip',
    status: 'active', source: 'capture_chat',
    confirmation: { confirmedByUserAt: '2026-11-01T09:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true },
    createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
    ...overrides,
  };
}

function occurrence(habitId: string, overrides: Partial<HabitOccurrence> = {}): HabitOccurrence {
  return { occurrenceId: `${habitId}.${DAY}.0`, habitId, localDate: DAY, ordinal: 0, state: 'pending', durationMinutes: 30, recoveredFromOccurrenceId: null, ...overrides };
}

const today = (occurrences: HabitOccurrence[], anyDay: string[] = []): HabitToday => ({ localDate: DAY, occurrences, anyDay });
const ids = (rows: ReturnType<typeof todayHabitRows>) => rows.map(row => row.occurrence.occurrenceId);

describe('todayHabitRows', () => {
  it('shows a daily habit\'s row for today, decided or not', () => {
    const rows = todayHabitRows([habit('walk'), habit('read')], today([occurrence('walk'), occurrence('read', { state: 'completed' })]));
    expect(ids(rows).sort()).toEqual([`read.${DAY}.0`, `walk.${DAY}.0`]);
    expect(rows.find(row => row.habit.habitId === 'read')?.occurrence.state).toBe('completed');
  });

  it('leaves out an off day a weekly count only allows: it is not due today', () => {
    const gym = habit('gym', { cadence: { kind: 'weekly_count', count: 3 }, minimumOccurrences: 3, maximumOccurrences: 3 });
    expect(todayHabitRows([gym], today([occurrence('gym')], [`gym.${DAY}.0`]))).toEqual([]);
  });

  it('leaves out a paused or archived habit, one it does not know, and another day\'s row', () => {
    const rows = todayHabitRows(
      [habit('paused', { status: 'paused' }), habit('archived', { status: 'archived' }), habit('walk')],
      today([occurrence('paused'), occurrence('archived'), occurrence('ghost'), occurrence('walk', { localDate: '2026-11-21', occurrenceId: 'walk.2026-11-21.0' })]),
    );
    expect(rows).toEqual([]);
  });

  it('orders by the hour each habit prefers, earliest first, and the ones with no hour after, in list order', () => {
    const rows = todayHabitRows(
      [
        habit('loose-b'),
        habit('evening', { preferredWindows: [{ start: '18:00', end: '19:00' }] }),
        habit('loose-a'),
        habit('morning', { preferredWindows: [{ start: '20:00', end: '21:00' }, { start: '07:00', end: '08:00' }] }),
      ],
      today([occurrence('loose-a'), occurrence('evening'), occurrence('loose-b'), occurrence('morning')]),
    );
    expect(rows.map(row => row.habit.habitId)).toEqual(['morning', 'evening', 'loose-b', 'loose-a']);
  });

  it('is empty while either read is missing', () => {
    expect(todayHabitRows(undefined, today([occurrence('walk')]))).toEqual([]);
    expect(todayHabitRows([habit('walk')], null)).toEqual([]);
    expect(todayHabitRows([habit('walk')], undefined)).toEqual([]);
  });
});

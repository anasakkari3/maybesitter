import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { GoalExecutionScreen, HabitDetailScreen } from '../ControlScreens';

const mockConfirmGoal = jest.fn();
const mockCreateHabit = jest.fn();
const mockCreateMemory = jest.fn();
const mockGenerate = jest.fn();
const mockRegenerate = jest.fn();
const mockUnlink = jest.fn();
let mockHabits: unknown[] = [];
const mockDecide = jest.fn();
let mockToday: unknown = null;
let mockTodayPending = false;

// M5a's email parts read through TanStack Query; these screens render here
// without a client, on a server whose M5a capability is off (today's screens).
jest.mock('../../m5a/capabilities', () => ({ useM5aCapabilities: () => null, useFreshM5aCapability: () => async () => false, M5A_NOT_NOW: () => new Error('not now') }));
// M5b-2a: the learned card reads the M5b capability; this panel renders without a QueryClient here.
jest.mock('../../m5b/capabilities', () => ({ useM5bOn: () => null, useFreshM5bOn: () => async () => null }));
jest.mock('../../m5b/suggestionBasis', () => {
  // Stable identities, as the real hooks keep (M5b-2b-1): M5b known off here.
  const stamping = {
    stamp: () => ({ startedAt: 0, now: false, lastKnown: false }),
    classify: (envelope: { basisMode?: string }) => ({ mode: envelope.basisMode ?? null, capAtFetch: false, offAtFetch: true, startedAt: 0 }),
  };
  const signals = { capNow: false, freshItems: null, listSettled: false, basisHidden: () => false, absorbRevision: () => undefined };
  return {
    useBasisStamp: () => stamping,
    useSuggestionBasisSignals: () => signals,
    basisClassVisible: (cls: unknown) => cls !== null,
  };
});
jest.mock('../../m5a/emailScan', () => ({
  useEmailScanOverview: () => ({ data: undefined, refetch: async () => undefined }),
  useGmailMonitorOn: () => null,
  EmailScanEntry: () => null,
  EmailScanStatus: () => null,
  WaitLine: () => null,
}));
jest.mock('../../m5a/AddedCard', () => ({ AddedCard: () => null }));

jest.mock('../../../api/queries', () => ({
  useConsents: () => ({ data: { recommendations: { state: 'granted' } } }),
  useIntelligenceDecided: () => () => undefined,
  useMemory: () => ({
    data: { items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot' }] },
    isPending: false, error: null, refetch: jest.fn(),
  }),
  useCreateMemory: () => ({ mutate: mockCreateMemory, isPending: false, error: null }),
  useGenerateGoalExecution: () => ({ mutate: mockGenerate, isPending: false, error: null }),
  useGoalExecution: () => ({
    data: {
      success: true,
      graph: {
        nodes: [
          { nodeId: 'proposal-1', kind: 'milestone_proposal', status: 'proposed', title: 'Recruit five participants', statedTiming: 'This week' },
          { nodeId: 'checkpoint-1', kind: 'checkpoint', status: 'confirmed', title: 'Review participant feedback', statedTiming: 'Friday' },
        ],
      },
      progress: { completedCount: 0, confirmedCount: 1 },
    },
    isPending: false, error: null, refetch: jest.fn(),
  }),
  useConfirmGoalSelections: () => ({ mutate: mockConfirmGoal, isPending: false, error: null }),
  useRegenerateGoalExecution: () => ({ mutate: mockRegenerate, isPending: false, error: null }),
  useUnlinkGoalNode: () => ({ mutate: mockUnlink, isPending: false, error: null }),
  useCommitment: () => ({ data: null, isPending: false, error: null, refetch: jest.fn() }),
  useHabits: () => ({ data: mockHabits, isPending: false, error: null, refetch: jest.fn() }),
  useCreateHabit: () => ({ mutate: mockCreateHabit, isPending: false, error: null }),
  useHabitsToday: () => ({ data: mockToday, isPending: mockTodayPending, error: null, refetch: jest.fn() }),
  useDecideHabitOccurrence: () => ({ mutate: mockDecide, isPending: false, error: null, variables: undefined }),
  useSetHabitStatus: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useDeleteHabit: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  usePlan: () => ({ data: null, isPending: false, error: null, refetch: jest.fn() }),
  usePlanAction: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  // The plan path (M3a): off in these renders unless a test says otherwise.
  useUpcomingPlans: () => ({ isPending: false, error: null, data: [] }),
  useGoalPlan: () => ({ data: { success: true, draft: null, confirmed: null, linkedWork: [] }, isSuccess: true, error: null, refetch: jest.fn() }),
  useInvalidateAfterPlanConfirm: () => () => undefined,
  useUid: () => 'u',
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const wrap = (child: React.ReactNode) => (
  <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}</AppProvider></SafeAreaProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  mockHabits = [];
  mockToday = null;
  mockTodayPending = false;
  mockGenerate.mockImplementation((_input, options: any) => options.onSuccess({
    generation: 1,
    nodes: [
      { nodeId: 'proposal-1', kind: 'milestone_proposal', status: 'proposed', title: 'Recruit five participants', statedTiming: 'This week' },
      { nodeId: 'checkpoint-1', kind: 'checkpoint', status: 'proposed', title: 'Review participant feedback', statedTiming: 'Friday' },
    ],
  }));
});
afterEach(cleanup);

it('saves a user-stated goal only after the user enters and confirms it', async () => {
  await render(wrap(<GoalExecutionScreen />));
  expect(screen.getByTestId('goal-add-save')).toBeDisabled();
  await fireEvent.changeText(screen.getByTestId('goal-add-input'), 'Finish the report');
  await fireEvent.press(screen.getByTestId('goal-add-save'));
  expect(mockCreateMemory).toHaveBeenCalledWith(
    { kind: 'goal', content: 'Finish the report', language: expect.stringMatching(/^(ar|en|he)$/) },
    expect.objectContaining({ onSuccess: expect.any(Function) }),
  );
});

it('creates a habit only after the user fills and confirms its concrete schedule', async () => {
  await render(wrap(<HabitDetailScreen />));
  await fireEvent.press(screen.getByTestId('habit-create'));
  await fireEvent.changeText(screen.getByTestId('habit-title-input'), 'Study algorithms');
  await fireEvent.press(screen.getByTestId('habit-create-confirm'));

  expect(mockCreateHabit).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Study algorithms',
    cadence: { kind: 'weekly_count', count: 3 },
    durationMinutes: 30,
    minimumOccurrences: 3,
    maximumOccurrences: 3,
    flexibility: 'flexible',
    recoveryPolicy: 'skip',
    source: 'user_created',
    confirmation: expect.objectContaining({
      sourceRef: null,
      acceptedSuggestedValues: true,
      confirmedByUserAt: expect.any(String),
    }),
  }), expect.any(Object));
});

/**
 * Habit cadence beyond 1× / 3× / 5× (audit 2026-10-03, #12).
 *
 * «بيلاتيس الثلاثاء والخميس» could not be said: the creator offered three
 * counts and no days. The server's cadence has always had both shapes
 * (`weekly_count` 1–7, and `weekdays`, 0 = Sunday).
 */
it('creates a Tuesday and Thursday habit from the days the user picks', async () => {
  await render(wrap(<HabitDetailScreen />));
  await fireEvent.press(screen.getByTestId('habit-create'));
  await fireEvent.changeText(screen.getByTestId('habit-title-input'), 'Pilates');
  await fireEvent.press(screen.getByTestId('habit-day-2'));
  await fireEvent.press(screen.getByTestId('habit-day-4'));
  expect(screen.getByTestId('habit-day-2').props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.getByTestId('habit-day-3').props.accessibilityState).toMatchObject({ checked: false });
  await fireEvent.press(screen.getByTestId('habit-create-confirm'));

  expect(mockCreateHabit).toHaveBeenCalledWith(expect.objectContaining({
    title: 'Pilates',
    cadence: { kind: 'weekdays', weekdays: [2, 4] },
    minimumOccurrences: 2,
    maximumOccurrences: 2,
  }), expect.any(Object));
});

it('offers every weekly count from 1 to 7', async () => {
  await render(wrap(<HabitDetailScreen />));
  await fireEvent.press(screen.getByTestId('habit-create'));
  for (const count of [1, 2, 3, 4, 5, 6, 7]) expect(screen.queryByTestId(`habit-count-${count}`)).not.toBeNull();
  await fireEvent.changeText(screen.getByTestId('habit-title-input'), 'Walk');
  // A day, then a count: the count wins and the day is cleared.
  await fireEvent.press(screen.getByTestId('habit-day-1'));
  await fireEvent.press(screen.getByTestId('habit-count-2'));
  expect(screen.getByTestId('habit-day-1').props.accessibilityState).toMatchObject({ checked: false });
  await fireEvent.press(screen.getByTestId('habit-create-confirm'));
  expect(mockCreateHabit).toHaveBeenCalledWith(expect.objectContaining({
    cadence: { kind: 'weekly_count', count: 2 },
    minimumOccurrences: 2,
    maximumOccurrences: 2,
  }), expect.any(Object));
});

it('falls back to the count when the last picked day is taken off', async () => {
  await render(wrap(<HabitDetailScreen />));
  await fireEvent.press(screen.getByTestId('habit-create'));
  await fireEvent.changeText(screen.getByTestId('habit-title-input'), 'Read');
  await fireEvent.press(screen.getByTestId('habit-day-5'));
  await fireEvent.press(screen.getByTestId('habit-day-5'));
  await fireEvent.press(screen.getByTestId('habit-create-confirm'));
  expect(mockCreateHabit).toHaveBeenCalledWith(expect.objectContaining({
    cadence: { kind: 'weekly_count', count: 3 },
  }), expect.any(Object));
});

/**
 * Only a step that repeats can become a habit (audit 2026-10-03, #12, screen
 * 26): «Install Node.js and npm» — a one-off the goal planner marked
 * `suggestedAs: 'commitment'` — was offered as a recurring habit.
 */
it('names a saved habit\'s duration, flexibility and recovery in words, not raw values', async () => {
  mockHabits = [{
    habitId: 'h1', title: 'Pilates', cadence: { kind: 'weekdays', weekdays: [2, 4] }, durationMinutes: 30,
    preferredWindows: [], minimumOccurrences: 2, maximumOccurrences: 3, flexibility: 'protected_flexible',
    recoveryPolicy: 'recover_within_period', status: 'active', source: 'user_created',
    confirmation: { confirmedByUserAt: '2026-10-03T00:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true },
    createdAt: '2026-10-03T00:00:00.000Z', updatedAt: '2026-10-03T00:00:00.000Z',
  }];
  await render(wrap(<HabitDetailScreen />));
  expect(screen.getByText(strings.en.xProtectedFlexible)).toBeTruthy();
  expect(screen.getByText(strings.en.xRecoverThisWeek)).toBeTruthy();
  expect(screen.queryByText('protected_flexible')).toBeNull();
  expect(screen.queryByText('recover_within_period')).toBeNull();
});

/**
 * CA5.4: today's occurrence of a habit can be marked done or not today from
 * the habit's own card, and the decision reads back from the server.
 */
const walk = {
  habitId: 'h1', title: 'Walk', cadence: { kind: 'weekdays', weekdays: [0, 1, 2, 3, 4, 5, 6] }, durationMinutes: 30,
  preferredWindows: [], minimumOccurrences: 7, maximumOccurrences: 7, flexibility: 'flexible', recoveryPolicy: 'skip',
  status: 'active', source: 'user_created',
  confirmation: { confirmedByUserAt: '2026-11-01T09:00:00.000Z', sourceRef: null, acceptedSuggestedValues: true },
  createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z',
};
const todayRow = (state: string) => ({ occurrenceId: 'h1.2026-11-15.0', habitId: 'h1', localDate: '2026-11-15', ordinal: 0, state, durationMinutes: 30, recoveredFromOccurrenceId: null });

it("marks today's occurrence done or not today from the habit's card", async () => {
  mockHabits = [walk];
  mockToday = { localDate: '2026-11-15', occurrences: [todayRow('pending')] };
  await render(wrap(<HabitDetailScreen />));
  await fireEvent.press(screen.getByTestId('habit-today-done-h1'));
  expect(mockDecide).toHaveBeenLastCalledWith({ habitId: 'h1', occurrenceId: 'h1.2026-11-15.0', outcome: 'completed' }, expect.any(Object));
  await fireEvent.press(screen.getByTestId('habit-today-skip-h1'));
  expect(mockDecide).toHaveBeenLastCalledWith({ habitId: 'h1', occurrenceId: 'h1.2026-11-15.0', outcome: 'skipped' }, expect.any(Object));
});

it.each<[string, 'xHabitTodayDone' | 'xHabitTodaySkipped']>([
  ['completed', 'xHabitTodayDone'],
  ['skipped', 'xHabitTodaySkipped'],
  ['recovered', 'xHabitTodaySkipped'],
])('a %s occurrence says what was decided and offers no second decision', async (state, key) => {
  mockHabits = [walk];
  mockToday = { localDate: '2026-11-15', occurrences: [todayRow(state)] };
  await render(wrap(<HabitDetailScreen />));
  expect(screen.getByTestId('habit-today-state-h1')).toHaveTextContent(strings.en[key]);
  expect(screen.queryByTestId('habit-today-done-h1')).toBeNull();
  expect(screen.queryByTestId('habit-today-skip-h1')).toBeNull();
});

it('a habit with nothing due today shows no today row', async () => {
  mockHabits = [walk];
  mockToday = { localDate: '2026-11-15', occurrences: [] };
  await render(wrap(<HabitDetailScreen />));
  expect(screen.queryByTestId('habit-today-h1')).toBeNull();
});

it("holds the habit cards until today's occurrences are known, so a card never appears without its today row", async () => {
  mockHabits = [walk];
  mockTodayPending = true;
  await render(wrap(<HabitDetailScreen />));
  expect(screen.queryByTestId('habit-toggle-h1')).toBeNull();
  expect(screen.getByTestId('query-loading')).toBeTruthy();
});

/**
 * A weekly-count habit counts on any day it is done (owner decision
 * 2026-11-15): an off day offers «done» only, the card says the week's
 * count, and a met week says so and asks nothing more.
 */
const gym = { ...walk, habitId: 'h1', title: 'Gym', cadence: { kind: 'weekly_count', count: 3 }, minimumOccurrences: 3, maximumOccurrences: 3 };

it('an off-day row offers done only, never not today', async () => {
  mockHabits = [gym];
  mockToday = { localDate: '2026-11-17', occurrences: [{ ...todayRow('pending'), occurrenceId: 'h1.2026-11-17.0', localDate: '2026-11-17' }], weeks: [{ habitId: 'h1', completed: 0, target: 3 }], anyDay: ['h1.2026-11-17.0'] };
  await render(wrap(<HabitDetailScreen />));
  await fireEvent.press(screen.getByTestId('habit-today-done-h1'));
  expect(mockDecide).toHaveBeenLastCalledWith({ habitId: 'h1', occurrenceId: 'h1.2026-11-17.0', outcome: 'completed' }, expect.any(Object));
  expect(screen.queryByTestId('habit-today-skip-h1')).toBeNull();
  expect(screen.getByTestId('habit-today-anyday-h1')).toHaveTextContent(strings.en.xHabitTodayAnyDay);
});

it("says the week's count on a weekly habit", async () => {
  mockHabits = [gym];
  mockToday = { localDate: '2026-11-18', occurrences: [todayRow('pending')], weeks: [{ habitId: 'h1', completed: 1, target: 3 }], anyDay: [] };
  await render(wrap(<HabitDetailScreen />));
  expect(screen.getByTestId('habit-week-h1')).toHaveTextContent('1 of 3 this week');
  expect(screen.getByTestId('habit-today-skip-h1')).toBeTruthy();
});

it('a met week says it is done for the week and asks nothing more', async () => {
  mockHabits = [gym];
  mockToday = { localDate: '2026-11-20', occurrences: [], weeks: [{ habitId: 'h1', completed: 3, target: 3 }], anyDay: [] };
  await render(wrap(<HabitDetailScreen />));
  expect(screen.getByTestId('habit-week-h1')).toHaveTextContent(strings.en.xHabitWeekDone);
  expect(screen.queryByTestId('habit-today-h1')).toBeNull();
});

function inLiveRegion(node: { props: Record<string, unknown>; parent: unknown } | null): boolean {
  for (let at = node; at; at = at.parent as typeof node) {
    if (at.props.accessibilityLiveRegion === 'polite' || at.props.accessibilityLiveRegion === 'assertive') return true;
  }
  return false;
}

it.each<[string, number]>([['counting', 1], ['met', 3]])("the week's count sits in a live region when %s, so a change is announced", async (_label, completed) => {
  mockHabits = [gym];
  mockToday = { localDate: '2026-11-18', occurrences: completed < 3 ? [todayRow('pending')] : [], weeks: [{ habitId: 'h1', completed, target: 3 }], anyDay: [] };
  await render(wrap(<HabitDetailScreen />));
  expect(inLiveRegion(screen.getByTestId('habit-week-h1') as never)).toBe(true);
});

it('a met week says the person finished their count, in all three languages', () => {
  expect(strings.ar.xHabitWeekDone).toBe('خلّصت عدّك لهالأسبوع');
  expect(strings.en.xHabitWeekDone).toBe("You've hit your count for this week");
  expect(strings.he.xHabitWeekDone).toBe('השלמת את המכסה של השבוע');
});

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

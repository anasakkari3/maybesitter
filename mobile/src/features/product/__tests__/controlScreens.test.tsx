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
const mockRegenerate = jest.fn();
const mockUnlink = jest.fn();

jest.mock('../../../api/queries', () => ({
  useMemory: () => ({
    data: { items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot' }] },
    isPending: false, error: null, refetch: jest.fn(),
  }),
  useCreateMemory: () => ({ mutate: mockCreateMemory, isPending: false, error: null }),
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
  useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
  useCreateHabit: () => ({ mutate: mockCreateHabit, isPending: false, error: null }),
  useSetHabitStatus: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useDeleteHabit: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  usePlan: () => ({ data: null, isPending: false, error: null, refetch: jest.fn() }),
  usePlanAction: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const wrap = (child: React.ReactNode) => (
  <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}</AppProvider></SafeAreaProvider>
);

beforeEach(() => { jest.clearAllMocks(); });
afterEach(cleanup);

it('shows checkpoints and requires an explicit target before goal work is created', async () => {
  await render(wrap(<GoalExecutionScreen />));
  expect(JSON.stringify(screen.toJSON())).toContain('Review participant feedback');
  await fireEvent.press(screen.getByLabelText(/Recruit five participants/));
  const t = Object.values(strings).find(value => screen.queryAllByText(value.xHabits).length > 0)!;
  await fireEvent.press(screen.getByText(t.xHabits));
  await fireEvent.press(screen.getByTestId('goal-confirm-goal-1'));

  expect(mockConfirmGoal).toHaveBeenCalledWith({
    generation: 1,
    selections: [{
      nodeId: 'proposal-1',
      as: 'habit',
      habit: {
        cadence: { kind: 'weekly_count', count: 3 },
        durationMinutes: 30,
        preferredWindows: [],
        minimumOccurrences: 3,
        maximumOccurrences: 3,
        flexibility: 'flexible',
        recoveryPolicy: 'skip',
      },
    }],
  }, expect.any(Object));
});

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

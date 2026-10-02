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

jest.mock('../../../api/queries', () => ({
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

beforeEach(() => {
  jest.clearAllMocks();
  mockGenerate.mockImplementation((_input, options: any) => options.onSuccess({
    generation: 1,
    nodes: [
      { nodeId: 'proposal-1', kind: 'milestone_proposal', status: 'proposed', title: 'Recruit five participants', statedTiming: 'This week' },
      { nodeId: 'checkpoint-1', kind: 'checkpoint', status: 'proposed', title: 'Review participant feedback', statedTiming: 'Friday' },
    ],
  }));
});
afterEach(cleanup);

it('shows checkpoints and requires an explicit target before goal work is created', async () => {
  await render(wrap(<GoalExecutionScreen />));
  await fireEvent.press(screen.getByTestId('goal-open-goal-1'));
  await fireEvent.press(screen.getByTestId('goal-generate'));
  expect(JSON.stringify(screen.toJSON())).toContain('Review participant feedback');
  await fireEvent.press(screen.getByLabelText(/Recruit five participants/));
  const t = Object.values(strings).find(value => screen.queryAllByText(value.xGoalAsHabit).length > 0)!;
  await fireEvent.press(screen.getByText(t.xGoalAsHabit));
  await fireEvent.press(screen.getByTestId('goal-confirm-selected'));

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
it('offers the habit choice only for steps that are not one-offs', async () => {
  mockGenerate.mockImplementation((_input, options: any) => options.onSuccess({
    generation: 2,
    nodes: [
      { nodeId: 'g1.step.node', kind: 'decomposition_step_proposal', status: 'proposed', stepId: 'node', title: 'Install Node.js and npm', sourceSpans: [], inferred: true, statedTiming: null, statedOwner: null, suggestedAs: 'commitment', suggestedWhen: 'today' },
      { nodeId: 'g1.step.practice', kind: 'decomposition_step_proposal', status: 'proposed', stepId: 'practice', title: 'Practise React components', sourceSpans: [], inferred: true, statedTiming: null, statedOwner: null, suggestedAs: 'habit' },
      { nodeId: 'g1.step.split', kind: 'decomposition_step_proposal', status: 'proposed', stepId: 'split', title: 'Read the React docs', sourceSpans: [], inferred: false, statedTiming: null, statedOwner: null },
    ],
  }));
  await render(wrap(<GoalExecutionScreen />));
  await fireEvent.press(screen.getByTestId('goal-open-goal-1'));
  await fireEvent.press(screen.getByTestId('goal-generate'));
  for (const title of ['Install Node.js and npm', 'Practise React components', 'Read the React docs']) {
    await fireEvent.press(screen.getByLabelText(new RegExp(title)));
  }
  expect(screen.queryByTestId('goal-kind-habit-g1.step.node')).toBeNull();
  expect(screen.queryByTestId('goal-kind-commitment-g1.step.node')).toBeNull();
  expect(screen.queryByTestId('goal-kind-habit-g1.step.practice')).not.toBeNull();
  expect(screen.queryByTestId('goal-kind-habit-g1.step.split')).not.toBeNull();

  // The habit step takes the same cadence picker, days included.
  await fireEvent.press(screen.getByTestId('goal-g1.step.practice-day-2'));
  await fireEvent.press(screen.getByTestId('goal-g1.step.practice-day-4'));
  await fireEvent.press(screen.getByTestId('goal-confirm-selected'));
  expect(mockConfirmGoal).toHaveBeenCalledWith({
    generation: 2,
    selections: expect.arrayContaining([
      { nodeId: 'g1.step.node', as: 'commitment' },
      expect.objectContaining({
        nodeId: 'g1.step.practice',
        as: 'habit',
        habit: expect.objectContaining({ cadence: { kind: 'weekdays', weekdays: [2, 4] }, minimumOccurrences: 2, maximumOccurrences: 2 }),
      }),
    ]),
  }, expect.any(Object));
});

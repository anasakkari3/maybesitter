/**
 * L6 (e): the open goal used to be local state, so the header's Back — which
 * walks the navigation history — popped the whole Goals screen from under an
 * open goal. The literal repro: Goals → a goal → header Back must show the
 * goals list, and only a second Back leaves Goals.
 */
import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { GoalExecutionScreen } from '../GoalExecutionScreen';

const graph = {
  version: 'v1', schema: 'goal-graph-v1', graphId: 'graph-1', goalMemoryId: 'goal-1', scopeId: 'user-1',
  language: 'en', nodes: [], edges: [], generatedAt: '2026-09-23T09:00:00.000Z', generation: 1,
  provenance: { decompositionProposalId: 'proposal-1', decompositionOutcome: 'decomposed' },
};
const progress = {
  scopeId: 'user-1', goalMemoryId: 'goal-1', confirmedCount: 0, completedCount: 0, nodes: [],
  derivedAt: '2026-09-23T09:00:00.000Z', period: { fromLocalDate: '2026-09-21', toLocalDate: '2026-09-27' },
};

jest.mock('../../../api/queries', () => ({
  useMemory: () => ({ data: { items: [{ id: 'goal-1', kind: 'goal', content: 'Launch the pilot' }] }, isPending: false, error: null, refetch: jest.fn() }),
  useCreateMemory: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useGoalExecution: () => ({ data: { success: true, graph, progress }, isPending: false, isFetching: false, error: null, refetch: jest.fn() }),
  useGenerateGoalExecution: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useRegenerateGoalExecution: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useConfirmGoalSelections: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useUnlinkGoalNode: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
  useCommitment: () => ({ data: undefined, isPending: false, error: null, refetch: jest.fn() }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

/** Opens Goals from Today the way the assistant row does, and shows whatever the history says is on top. */
function Harness() {
  const { s, actions } = useApp();
  const opened = React.useRef(false);
  React.useEffect(() => {
    if (!opened.current) { opened.current = true; actions.go('goalExecution'); }
  }, [actions]);
  return s.screen === 'goalExecution' ? <GoalExecutionScreen /> : <Text testID="probe-screen">{s.screen}</Text>;
}

beforeEach(async () => {
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
});
afterEach(cleanup);

it('header Back closes the open goal first, then leaves Goals', async () => {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><Harness /></AppProvider></SafeAreaProvider>);
  await waitFor(() => expect(screen.queryByTestId('goal-open-goal-1')).not.toBeNull());

  await fireEvent.press(screen.getByTestId('goal-open-goal-1'));
  await waitFor(() => expect(screen.queryByTestId('goal-back-list')).not.toBeNull());
  expect(screen.getByText(/Launch the pilot/)).toBeTruthy();

  await fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.queryByTestId('goal-back-list')).toBeNull());
  expect(screen.getByText(strings.en.xGoalSaved)).toBeTruthy();
  expect(screen.getByTestId('goal-open-goal-1')).toBeTruthy();

  await fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.getByTestId('probe-screen').props.children).toBe('today'));
});

it('the in-page back to goals is the same step as the header back', async () => {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><Harness /></AppProvider></SafeAreaProvider>);
  await waitFor(() => expect(screen.queryByTestId('goal-open-goal-1')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('goal-open-goal-1'));
  await waitFor(() => expect(screen.queryByTestId('goal-back-list')).not.toBeNull());

  await fireEvent.press(screen.getByTestId('goal-back-list'));
  await waitFor(() => expect(screen.queryByTestId('goal-open-goal-1')).not.toBeNull());
  await fireEvent.press(screen.getByTestId('header-back'));
  await waitFor(() => expect(screen.getByTestId('probe-screen').props.children).toBe('today'));
});

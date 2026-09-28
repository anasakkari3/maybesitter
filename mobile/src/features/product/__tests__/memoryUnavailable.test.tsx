/**
 * Memory switched off on the server (`moduleGate.ts`, 404 `feature_unavailable`).
 *
 * On the first device run the personalization toggle sat above an error box
 * reading «هاد ما عاد موجود» ("that's gone") with a Retry that could never
 * work, and the goals screen offered a goal input whose save could only fail.
 * A switched-off module is a state: the section says it is not available.
 */
import React from 'react';
import { beforeEach, expect, it, jest } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { strings } from '../../../i18n/strings';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { FeatureUnavailableError } from '../../../api/errors';
import { PersonalizationScreen } from '../ContextScreens';
import { GoalExecutionScreen } from '../../goals/GoalExecutionScreen';

let mockMemoryError: unknown;
jest.mock('../../../api/queries', () => ({
  useMemory: () => ({ data: undefined, isPending: false, error: mockMemoryError, refetch: jest.fn() }),
  useConsents: () => ({ data: { currentVersions: { personalization: 'v1' }, personalization: { state: 'granted' } }, isPending: false, error: null, refetch: jest.fn() }),
  useSetPersonalizationConsent: () => ({ mutateAsync: jest.fn() }),
  useCreateMemory: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useMemorySuggestion: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useGoalExecution: () => ({ data: undefined, isPending: false, isFetching: false, error: null, refetch: jest.fn() }),
  useGenerateGoalExecution: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useRegenerateGoalExecution: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useConfirmGoalSelections: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useUnlinkGoalNode: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useHabits: () => ({ data: [], isPending: false, error: null, refetch: jest.fn() }),
  useCommitment: () => ({ data: undefined, isPending: false, error: null, refetch: jest.fn() }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const t = strings.en;
const wrap = (child: React.ReactNode) => <SafeAreaProvider initialMetrics={metrics}><AppProvider>{child}</AppProvider></SafeAreaProvider>;

beforeEach(async () => {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  mockMemoryError = new FeatureUnavailableError('not found');
});

it('personalization keeps its toggle and says learning is not available, with no error box', async () => {
  await render(wrap(<PersonalizationScreen />));
  expect(await screen.findByTestId('personalization-toggle')).toBeTruthy();
  expect(screen.getByText(t.errorsFeatureDisabled)).toBeTruthy();
  expect(screen.queryByTestId('query-error')).toBeNull();
  expect(screen.queryByText(t.errorsNotFound)).toBeNull();
  expect(screen.queryByText(t.errorsRetry)).toBeNull();
});

it('goals say they are not available instead of offering an input that cannot save', async () => {
  await render(wrap(<GoalExecutionScreen />));
  expect(await screen.findByText(t.errorsFeatureDisabled)).toBeTruthy();
  expect(screen.queryByTestId('goal-add-input')).toBeNull();
  expect(screen.queryByTestId('query-error')).toBeNull();
});

it('an ordinary failure still offers a Retry', async () => {
  mockMemoryError = new Error('offline');
  await render(wrap(<PersonalizationScreen />));
  expect(await screen.findByTestId('query-error')).toBeTruthy();
  expect(screen.getByText(t.errorsRetry)).toBeTruthy();
});

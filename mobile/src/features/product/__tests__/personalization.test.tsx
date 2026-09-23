import React from 'react';
import { beforeEach, expect, it, jest } from '@jest/globals';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { PersonalizationScreen } from '../ContextScreens';
import mockFixture from '../../../api/__fixtures__/memory.withSuggestion.json';
import { strings } from '../../../i18n/strings';
const mockCreate = jest.fn();
const mockDecide = jest.fn();
jest.mock('../../../api/queries', () => ({
  useMemory: () => ({ data: mockFixture, isPending: false, error: null, refetch: jest.fn() }),
  useConsents: () => ({ data: { currentVersions: { personalization: 'v1' }, personalization: { state: 'granted' } }, isPending: false, error: null, refetch: jest.fn() }),
  useSetPersonalizationConsent: () => ({ mutateAsync: jest.fn() }),
  useCreateMemory: () => ({ mutate: mockCreate, isPending: false, error: null, reset: jest.fn() }),
  useMemorySuggestion: () => ({ mutate: mockDecide, isPending: false, error: null }),
}));
const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
beforeEach(() => { jest.clearAllMocks(); });
it('editing learning requires an explicit save and does not accept the original suggestion', async () => {
  await render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><PersonalizationScreen /></AppProvider></SafeAreaProvider>);
  const t = Object.values(strings).find(value => screen.queryAllByText(value.xLearned).length > 0)!;
  await fireEvent.press(screen.getAllByLabelText(t.memoryEdit)[0]!);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockDecide).not.toHaveBeenCalled();
  await fireEvent.changeText(screen.getByTestId('personalization-edit-input'), 'I prefer quiet mornings');
  await fireEvent.press(screen.getByTestId('personalization-edit-save'));
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ kind: 'preference', content: 'I prefer quiet mornings' }), expect.any(Object));
  expect(mockDecide).not.toHaveBeenCalled();
});

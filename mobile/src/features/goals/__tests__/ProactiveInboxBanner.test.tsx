/**
 * Today's quiet entry to the proactive loop, in a production build (review
 * of 2026-10-03). Until then it returned early unless the build was staging,
 * so the loop the owner released on 2026-10-01 never appeared. Whether it
 * shows is now the server's answer.
 */
import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider, useApp } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import en from '../../../i18n/locales/en.json';
import { FeatureUnavailableError, ForbiddenError } from '../../../api/errors';
import { ProactiveInboxBanner } from '../ProactiveInboxBanner';

const mockGenerate = jest.fn<any>();
jest.mock('../../../api/endpoints/intelligence', () => ({
  generateIntelligenceSuggestions: (...args: unknown[]) => mockGenerate(...args),
}));

const suggestion = (id: string, title: string, status = 'pending') => ({
  id, kind: 'action', title, reason: 'Your exam is tomorrow', observationIds: ['obs-1'], confidence: 0.8,
  durationMinutes: 45, status, decidedAt: null, linkedEntityId: null, generatedAt: '2026-10-03T08:00:00.000Z',
});

function Probe() {
  const { s } = useApp();
  return <Text testID="probe-screen">{s.screen}</Text>;
}

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const show = () => render(<SafeAreaProvider initialMetrics={metrics}><AppProvider><ProactiveInboxBanner /><Probe /></AppProvider></SafeAreaProvider>);

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_APP_ENV = 'production';
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
});
afterEach(async () => { await cleanup(); delete process.env.EXPO_PUBLIC_APP_ENV; });

it('shows the first waiting suggestion in a production build, asked for as a visit, and leads to «يتابع لك»', async () => {
  mockGenerate.mockResolvedValue({ success: true, schedule: [], suggestions: [
    suggestion('done', 'Already accepted', 'accepted'),
    suggestion('s1', 'Review the exam notes'),
  ] });
  await show();
  await waitFor(() => expect(screen.queryByTestId('today-proactive-suggestion')).not.toBeNull());
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockGenerate.mock.calls[0]![0]).toMatchObject({ visit: true });
  expect(screen.getByText(/Review the exam notes/)).toBeTruthy();
  expect(screen.queryByText(/Already accepted/)).toBeNull();
  expect(screen.getByText(en.suggestionNote)).toBeTruthy();
  await fireEvent.press(screen.getByTestId('today-proactive-review'));
  expect(screen.getByTestId('probe-screen')).toHaveTextContent('watching');
});

it.each([
  ['the loop is switched off', () => new FeatureUnavailableError('not found')],
  ['consent is required', () => new ForbiddenError('forbidden', 'consent_required')],
])('shows nothing, and no error, when %s', async (_label, error) => {
  mockGenerate.mockRejectedValue(error());
  await show();
  await waitFor(() => expect(mockGenerate).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.queryByTestId('today-proactive-suggestion')).toBeNull();
  expect(screen.queryByText(en.errorsFeatureDisabled)).toBeNull();
  expect(screen.queryByText(en.errorsConsentRequired)).toBeNull();
});

it('shows nothing when nothing is waiting', async () => {
  mockGenerate.mockResolvedValue({ success: true, schedule: [], suggestions: [] });
  await show();
  await waitFor(() => expect(mockGenerate).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.queryByTestId('today-proactive-suggestion')).toBeNull();
});

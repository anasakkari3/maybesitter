import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { IntelligencePanel } from '../IntelligencePanel';
import { FeatureUnavailableError, ForbiddenError, NetworkError } from '../../../api/errors';
import en from '../../../i18n/locales/en.json';
import { Text } from 'react-native';

const mockAnalyze = jest.fn<any>();
const mockGenerate = jest.fn<any>();
const mockInbox = jest.fn<any>();
const mockDecide = jest.fn<any>();
const mockReview = jest.fn<any>();
const mockScan = jest.fn<any>();
const mockMonitor = jest.fn<any>();
const mockSetMonitor = jest.fn<any>();
const onChanged = jest.fn();
let currentInbox: any;

jest.mock('../../../api/endpoints/intelligence', () => ({
  analyzeIntelligenceStatement: (...args: unknown[]) => mockAnalyze(...args),
  generateIntelligenceSuggestions: (...args: unknown[]) => mockGenerate(...args),
  getIntelligenceInbox: (...args: unknown[]) => mockInbox(...args),
  decideIntelligenceSuggestion: (...args: unknown[]) => mockDecide(...args),
  reviewIntelligenceObservation: (...args: unknown[]) => mockReview(...args),
  scanGmailForIntelligence: (...args: unknown[]) => mockScan(...args),
  getGmailIntelligenceMonitor: (...args: unknown[]) => mockMonitor(...args),
  setGmailIntelligenceMonitor: (...args: unknown[]) => mockSetMonitor(...args),
}));

const observedAt = '2026-09-30T10:00:00.000Z';
const evidence = {
  id: 'obs-1', kind: 'goal', evidence: 'I want more Pilates time', confidence: 1,
  source: 'manual', sourceRef: 'note-1', observedAt, review: 'pending', reviewedAt: null, linkedMemoryId: null,
};
const suggestion = {
  id: 'proposal-1', kind: 'action', title: 'Find a Pilates class', reason: 'You want more Pilates time',
  observationIds: ['obs-1'], confidence: 0.8, durationMinutes: 30,
  status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: observedAt,
};

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
const wrap = (props: Partial<React.ComponentProps<typeof IntelligencePanel>> = {}) =>
  <SafeAreaProvider initialMetrics={metrics}><AppProvider><IntelligencePanel onChanged={onChanged} {...props} /></AppProvider></SafeAreaProvider>;

beforeEach(async () => {
  jest.clearAllMocks();
  // The production build (review of 2026-10-03): the loop was released to
  // production on 2026-10-01, and whether it shows is the server's answer.
  process.env.EXPO_PUBLIC_APP_ENV = 'production';
  await AsyncStorage.clear();
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  currentInbox = { success: true, observations: [], suggestions: [], schedule: [] };
  mockInbox.mockImplementation(() => Promise.resolve(currentInbox));
  mockAnalyze.mockResolvedValue({ success: true, observations: [evidence] });
  mockGenerate.mockResolvedValue({ success: true, suggestions: [suggestion], schedule: [] });
  mockDecide.mockResolvedValue({ success: true, suggestion: { ...suggestion, status: 'accepted' } });
  mockMonitor.mockResolvedValue({ success: true, enabled: false, lastSuccessAt: null, error: null });
  mockSetMonitor.mockResolvedValue({ success: true, enabled: true, lastSuccessAt: null, error: null });
});
afterEach(async () => { await cleanup(); delete process.env.EXPO_PUBLIC_APP_ENV; });

it('takes a wish through analysis, multi-step review surface, and explicit confirmation', async () => {
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('intelligence-statement'), 'I want more Pilates time');
  await waitFor(() => expect(screen.getByTestId('intelligence-statement').props.value).toBe('I want more Pilates time'));
  currentInbox = { success: true, observations: [evidence], suggestions: [], schedule: [] };
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-analyze')); });
  await waitFor(() => expect(mockAnalyze).toHaveBeenCalledWith('I want more Pilates time'));
  await waitFor(() => expect(mockInbox).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText(/I want more Pilates time/)).not.toBeNull());
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await act(async () => { await fireEvent.press(screen.getByTestId('intelligence-generate')); });
  await waitFor(() => expect(mockGenerate).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/Find a Pilates class/)).not.toBeNull());
  expect(mockDecide).not.toHaveBeenCalled();
  await act(async () => { await fireEvent.press(screen.getByText('Add to my plan')); });
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('proposal-1', 'accept', undefined, undefined));
});

it('lets the person correct a suggestion before accepting it', async () => {
  const slot = { startsAt: '2026-09-30T11:00:00.000Z', endsAt: '2026-09-30T11:30:00.000Z' };
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion],
    schedule: [{ suggestionId: suggestion.id, slot, reason: null }] };
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-edit-proposal-1')).not.toBeNull());
  await fireEvent.changeText(screen.getByTestId('intelligence-edit-proposal-1'), 'Book a Pilates class');
  await act(async () => { await fireEvent.press(screen.getByText('Add to my plan')); });
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('proposal-1', 'accept', 'Book a Pilates class', slot));
});

it('shows in a production build when the server answers, with each suggestion marked as only a suggestion', async () => {
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(wrap());
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
  expect(screen.getByText(/Find a Pilates class/)).toBeTruthy();
  expect(within(screen.getByTestId('intelligence-suggestion-proposal-1')).getByText(`From: ${evidence.evidence}`)).toBeTruthy();
  expect(screen.getAllByText(en.suggestionNote)).toHaveLength(1);
  // Showing is not deciding.
  expect(mockDecide).not.toHaveBeenCalled();
  expect(mockGenerate).not.toHaveBeenCalled();
});

it('on «يتابع لك» asks for suggestions as a visit, then shows them for review', async () => {
  mockGenerate.mockImplementation(async () => {
    currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
    return { success: true, suggestions: [suggestion], schedule: [] };
  });
  await render(wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> }));
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
  expect(mockGenerate).toHaveBeenCalledTimes(1);
  expect(mockGenerate).toHaveBeenCalledWith({ visit: true });
  expect(screen.queryByTestId('off')).toBeNull();
  await act(async () => { await fireEvent.press(within(screen.getByTestId('intelligence-suggestion-proposal-1')).getByText('Not for me')); });
  await waitFor(() => expect(mockDecide).toHaveBeenCalledWith('proposal-1', 'dismiss'));
});

it.each([
  ['the loop switched off (404 feature_unavailable)', () => new FeatureUnavailableError('not found')],
  ['AI consent refused (403 consent_required)', () => new ForbiddenError('forbidden', 'consent_required')],
])('steps aside cleanly when %s: no error, no claim of a suggestion', async (_label, error) => {
  mockGenerate.mockRejectedValue(error());
  await render(wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> }));
  await waitFor(() => expect(screen.queryByTestId('off')).not.toBeNull());
  expect(screen.queryByTestId('intelligence-statement')).toBeNull();
  expect(screen.queryByText(en.suggestionNote)).toBeNull();
  expect(screen.queryByTestId('query-error')).toBeNull();
  expect(screen.queryByText(en.errorsRetry)).toBeNull();
  expect(mockInbox).not.toHaveBeenCalled();
});

it('hides on the Goals screen when the server has the loop off', async () => {
  mockInbox.mockRejectedValue(new FeatureUnavailableError('not found'));
  await render(wrap());
  await waitFor(() => expect(mockInbox).toHaveBeenCalled());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(screen.queryByTestId('intelligence-statement')).toBeNull();
  expect(screen.queryByText(en.errorsFeatureDisabled)).toBeNull();
});

it('a failed visit generation still shows what is already waiting; a dead Gmail switch does not hide the review', async () => {
  mockGenerate.mockRejectedValue(new NetworkError('offline'));
  mockMonitor.mockRejectedValue(new NetworkError('offline'));
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> }));
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
  expect(screen.queryByTestId('off')).toBeNull();
});

it('on «يتابع لك» a failed read offers Retry, and Retry reads again', async () => {
  mockInbox.mockRejectedValueOnce(new NetworkError('offline'));
  currentInbox = { success: true, observations: [evidence], suggestions: [suggestion], schedule: [] };
  await render(wrap({ autoGenerate: true, whenOff: <Text testID="off">off</Text> }));
  await waitFor(() => expect(screen.queryByTestId('query-error')).not.toBeNull());
  expect(screen.queryByTestId('off')).toBeNull();
  await act(async () => { await fireEvent.press(screen.getByText(en.errorsRetry)); });
  await waitFor(() => expect(screen.queryByTestId('intelligence-suggestion-proposal-1')).not.toBeNull());
});

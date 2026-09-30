import React from 'react';
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { IntelligencePanel } from '../IntelligencePanel';

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
const wrap = () => <SafeAreaProvider initialMetrics={metrics}><AppProvider><IntelligencePanel onChanged={onChanged} /></AppProvider></SafeAreaProvider>;

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.EXPO_PUBLIC_APP_ENV = 'staging';
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
  await waitFor(() => expect(screen.queryByText('Find a Pilates class')).not.toBeNull());
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

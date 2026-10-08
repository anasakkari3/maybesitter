/**
 * After a habit answer redraws the card, the screen reader moves to what is
 * there now — the next question, then the finished rhythm (DESIGN-M3b a11y 5).
 * Inspection M3B-A-007: the focused radio vanished and focus went nowhere.
 */
import React from 'react';
import { afterEach, expect, it, jest } from '@jest/globals';
import { AccessibilityInfo } from 'react-native';
import { cleanup, render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { HabitProposalCard } from '../ProposalPointCards';
import type { CaptureHabitProposal } from '../../../api/schemas/capture';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'UTC' }]),
  getLocales: jest.fn(() => [{ languageCode: 'ar', languageTag: 'ar', textDirection: 'rtl' }]),
}));

const METRICS: Metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };
afterEach(async () => { await cleanup(); jest.restoreAllMocks(); });

const base: CaptureHabitProposal = {
  habitItemId: 'h1', pointId: 'P', title: 'امشي', cadence: null, durationMinutes: null, preferredWindow: null,
  explanation: null, question: { field: 'frequency', options: [1, 2, 3, 7] }, confirmable: false,
};

function card(habit: CaptureHabitProposal) {
  return (
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <HabitProposalCard habit={habit} selected={false} onToggle={jest.fn()} onAnswer={jest.fn()} busy={false} reask={false} />
      </AppProvider>
    </SafeAreaProvider>
  );
}

it('focus follows the next question, then the finished explanation, and never on first draw', async () => {
  const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => undefined);
  const view = await render(card(base));
  expect(focus).not.toHaveBeenCalled();

  await view.rerender(card({ ...base, cadence: { kind: 'weekly_count', count: 7 }, question: { field: 'duration', options: [15, 30, 45, 60] } }));
  expect(focus).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenLastCalledWith(expect.anything(), 'focus');

  await view.rerender(card({
    ...base, cadence: { kind: 'weekly_count', count: 7 }, durationMinutes: 30, question: null,
    explanation: 'كل يوم، نص ساعة.', confirmable: true,
  }));
  expect(focus).toHaveBeenCalledTimes(2);
  // A real element, not a stale ref.
  expect(focus.mock.calls[1]![0]).not.toBeNull();
  expect(view.getByTestId('capture-habit-explanation-P')).toBeTruthy();
});

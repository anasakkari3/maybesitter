/**
 * Typing Arabic into a field that starts on the left (first iPhone run, L7).
 *
 * `textAlignment('start', …)` is the Text helper: iOS Fabric swaps a Text's
 * alignment under an inherited RTL direction, so it hands back the physical
 * 'left' for Arabic on iOS. A TextInput is not swapped, so the same value put
 * the caret and the placeholder on the left in Arabic. Inputs take the
 * physical edge (`rtl ? 'right' : 'left'`) and the writing direction.
 */
import React from 'react';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { CommitmentsScreen, PersonalizationScreen } from '../ContextScreens';
import mockFixture from '../../../api/__fixtures__/memory.withSuggestion.json';
import ar from '../../../i18n/locales/ar.json';
import one from '../../../api/__fixtures__/commitments.one.json';

let mockDenseItems: unknown[] = [];

// M6a-1: the server search capability, off here (these screens render without a QueryClient).
jest.mock('../../m6/capabilities', () => ({ useSearchHistoryOn: () => false }));
jest.mock('../../../api/queries', () => ({
  useUid: () => 'u',
  // M6a-1: the server search; off in these tests (no capability answer).
  useCommitmentSearch: () => ({ data: undefined, isPending: false, error: null }),
  useToday: () => ({ data: { items: mockDenseItems }, isPending: false, error: null, refetch: jest.fn() }),
  useUpcoming: () => ({ data: { items: [] }, isPending: false, error: null, refetch: jest.fn() }),
  useIntelligenceDecided: () => () => undefined,
  useMemory: () => ({ data: mockFixture, isPending: false, error: null, refetch: jest.fn() }),
  useConsents: () => ({ data: { currentVersions: { personalization: 'v1' }, personalization: { state: 'granted' } }, isPending: false, error: null, refetch: jest.fn() }),
  useSetPersonalizationConsent: () => ({ mutateAsync: jest.fn() }),
  useCreateMemory: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useMemorySuggestion: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

afterEach(async () => {
  mockDenseItems = [];
  await cleanup();
  await AsyncStorage.clear();
});

async function show(lang: 'ar' | 'en', node: React.ReactElement) {
  await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  return render(<SafeAreaProvider initialMetrics={metrics}><AppProvider>{node}</AppProvider></SafeAreaProvider>);
}

const styleOf = (testID: string) => StyleSheet.flatten(screen.getByTestId(testID).props.style);

describe('text fields in Arabic start on the right', () => {
  it.each([
    ['ar', 'right', 'rtl'],
    ['en', 'left', 'ltr'],
  ] as ['ar' | 'en', string, string][])('%s: the commitments search', async (lang, align, direction) => {
    await show(lang, <CommitmentsScreen />);
    expect(await screen.findByTestId('commitments-search')).toBeTruthy();
    expect(styleOf('commitments-search').textAlign).toBe(align);
    expect(styleOf('commitments-search').writingDirection).toBe(direction);
  });

  it('ar: the learning edit field', async () => {
    await show('ar', <PersonalizationScreen />);
    await fireEvent.press((await screen.findAllByLabelText(ar.memoryEdit))[0]!);
    expect(styleOf('personalization-edit-input').textAlign).toBe('right');
    expect(styleOf('personalization-edit-input').writingDirection).toBe('rtl');
  });
});

describe('a crowded commitment list', () => {
  it('keeps search and status controls visible while a late item is found among 60', async () => {
    mockDenseItems = Array.from({ length: 60 }, (_, index) => ({
      ...one,
      id: `dense-${index}`,
      title: index === 54 ? 'Renew passport needle' : `Commitment ${index}`,
      timeSpec: { ...one.timeSpec, dueAt: new Date(Date.UTC(2099, 0, index + 1, 10)).toISOString() },
    }));
    await show('en', <CommitmentsScreen />);
    expect(screen.getByTestId('commitments-list')).toBeTruthy();
    expect(screen.getByTestId('commitments-result-count').props.children).toContain('60');
    await fireEvent.changeText(screen.getByTestId('commitments-search'), 'needle');
    expect(screen.getByTestId('commitments-result-count').props.children).toContain('1');
    expect(screen.getByTestId('commitments-item-dense-54')).toBeTruthy();
    expect(screen.getByTestId('commitments-search')).toBeTruthy();
  });
});

/**
 * V3-F08-01: «الكل» showed active and done, and the item dropped on purpose
 * only turned up in a search. «أسقطه بوعي» has the same weight as «تمّت», so
 * «الكل» holds it too; the open and done filters still leave it out.
 */
describe('the «all» filter', () => {
  it('holds an item dropped on purpose; open and done do not', async () => {
    const at = (day: number) => new Date(Date.UTC(2099, 0, day, 10)).toISOString();
    mockDenseItems = [
      { ...one, id: 'open-1', title: 'Open one', timeSpec: { ...one.timeSpec, dueAt: at(1) } },
      { ...one, id: 'done-1', title: 'Done one', status: 'completed', completedAt: at(2), timeSpec: { ...one.timeSpec, dueAt: at(2) } },
      { ...one, id: 'dropped-1', title: 'Dropped one', status: 'dropped', droppedAt: at(3), timeSpec: { ...one.timeSpec, dueAt: at(3) } },
    ];
    await show('en', <CommitmentsScreen />);
    await fireEvent.press(screen.getByTestId('commitments-filter-all'));
    expect(screen.getByTestId('commitments-item-open-1')).toBeTruthy();
    expect(screen.getByTestId('commitments-item-done-1')).toBeTruthy();
    expect(screen.getByTestId('commitments-item-dropped-1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('commitments-filter-active'));
    expect(screen.queryByTestId('commitments-item-dropped-1')).toBeNull();
    await fireEvent.press(screen.getByTestId('commitments-filter-done'));
    expect(screen.queryByTestId('commitments-item-dropped-1')).toBeNull();
    expect(screen.getByTestId('commitments-item-done-1')).toBeTruthy();
  });
});

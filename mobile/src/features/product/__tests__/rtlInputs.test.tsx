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

jest.mock('../../../api/queries', () => ({
  useToday: () => ({ data: { items: [] }, isPending: false, error: null, refetch: jest.fn() }),
  useUpcoming: () => ({ data: { items: [] }, isPending: false, error: null, refetch: jest.fn() }),
  useMemory: () => ({ data: mockFixture, isPending: false, error: null, refetch: jest.fn() }),
  useConsents: () => ({ data: { currentVersions: { personalization: 'v1' }, personalization: { state: 'granted' } }, isPending: false, error: null, refetch: jest.fn() }),
  useSetPersonalizationConsent: () => ({ mutateAsync: jest.fn() }),
  useCreateMemory: () => ({ mutate: jest.fn(), isPending: false, error: null, reset: jest.fn() }),
  useMemorySuggestion: () => ({ mutate: jest.fn(), isPending: false, error: null }),
}));

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

afterEach(async () => {
  cleanup();
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

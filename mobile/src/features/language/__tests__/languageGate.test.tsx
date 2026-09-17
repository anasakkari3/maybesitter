import React from 'react';
import { beforeEach, describe, expect, it } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { LANGUAGE_STORAGE_KEY } from '../../../i18n/language';
import { LanguageGate } from '../LanguageGate';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

/**
 * A fresh install chooses its language before it sees sign-in (#469).
 *
 * The gate is driven the way a person drives it — tap עברית, tap Continue —
 * and the claims are what they would see: the screen itself flips to Hebrew
 * the moment the option is tapped, sign-in appears only after Continue, and
 * the choice is in the same key Settings reads. A stored preference from an
 * earlier build means the question was already answered, so it is not asked.
 */

/** Insets a test can rely on: SafeAreaProvider never measures under Jest. */
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const mount = () => render(
  <SafeAreaProvider initialMetrics={METRICS}>
    <AppProvider>
      <LanguageGate>
        <Text>SIGN IN</Text>
      </LanguageGate>
    </AppProvider>
  </SafeAreaProvider>,
);

describe('language gate', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('asks a fresh install for its language, then lets it through in that language', async () => {
    await mount();
    await waitFor(() => expect(screen.getByTestId('language-continue')).toBeTruthy());
    expect(screen.getByText(en.langTitle)).toBeTruthy();
    expect(screen.getByText(en.langHint)).toBeTruthy();
    expect(screen.queryByText('SIGN IN')).toBeNull();

    // Picking Hebrew re-renders the screen in Hebrew at once, before Continue.
    await fireEvent.press(screen.getByTestId('language-option-he'));
    await waitFor(() => expect(screen.getByText(he.langTitle)).toBeTruthy());
    expect(screen.getByTestId('language-option-he').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByTestId('language-option-en').props.accessibilityState).toMatchObject({ selected: false });
    expect(screen.queryByText('SIGN IN')).toBeNull();

    await fireEvent.press(screen.getByTestId('language-continue'));
    await waitFor(() => expect(screen.getByText('SIGN IN')).toBeTruthy());
    expect(screen.queryByTestId('language-continue')).toBeNull();
    await waitFor(async () => expect(await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('he'));
  });

  it('does not ask again when a language was chosen before', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'ar');
    await mount();
    await waitFor(() => expect(screen.getByText('SIGN IN')).toBeTruthy());
    expect(screen.queryByTestId('language-continue')).toBeNull();
    expect(screen.queryByTestId('language-loading')).toBeNull();
  });

  it('holds on a blank screen until the store has answered', async () => {
    await mount();
    // Synchronously after mount nothing has been read yet.
    expect(screen.queryByText('SIGN IN')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('language-continue')).toBeTruthy());
  });
});

/**
 * The sign-in screen (Stitch `08-sign-in`): the email button opens the email
 * form on sign-in, the new-account link opens it on sign-up, and the language
 * switch changes the screen's language in place — before anyone signs in.
 */
import React from 'react';
import { afterEach, describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthGate } from '../AuthGate';
import { AuthProvider } from '../AuthProvider';
import { createFakeAuthRepository } from '../fakeAuthRepository';
import { LANGUAGE_STORAGE_KEY } from '../../i18n/language';
import en from '../../i18n/locales/en.json';
import ar from '../../i18n/locales/ar.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function renderGate() {
  const repository = createFakeAuthRepository({ initialUser: null });
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <AuthGate appleSlot={null} googleSlot={null}>
            <Text>THE APP</Text>
          </AuthGate>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  return repository;
}

afterEach(async () => { await AsyncStorage.clear(); });

describe('the email entries', () => {
  it('«continue with email» opens the form on signing in', async () => {
    await renderGate();
    await fireEvent.press(screen.getByTestId('signin-email'));
    expect(screen.getAllByText(en.authModeSignIn).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.authForgotPassword)).not.toBeNull();
    expect(screen.queryByText(en.authTitle)).toBeNull();
  });

  it('the new-account link opens the same form on creating an account, and back returns', async () => {
    await renderGate();
    await fireEvent.press(screen.getByTestId('signin-create-account'));
    expect(screen.getAllByText(en.authModeSignUp).length).toBeGreaterThan(0);
    expect(screen.queryByText(en.authForgotPassword)).toBeNull();
    await fireEvent.press(screen.getByLabelText(en.back));
    expect(screen.getByText(en.authTitle)).toBeTruthy();
  });
});

describe('the language switch', () => {
  it('names each language in itself, at a 44-point target, and switches in place', async () => {
    await AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
    await renderGate();
    await waitFor(() => expect(screen.queryByText(en.authTitle)).not.toBeNull());
    const arabic = screen.getByTestId('signin-language-ar');
    expect(arabic.props.accessibilityLabel).toBe('العربية');
    expect(screen.getByTestId('signin-language-en').props.accessibilityState).toEqual({ selected: true });
    await fireEvent.press(arabic);
    await waitFor(() => expect(screen.queryByText(ar.authTitle)).not.toBeNull());
    expect(screen.getByTestId('signin-language-ar').props.accessibilityState).toEqual({ selected: true });
    expect(await AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('ar');
  });
});

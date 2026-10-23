/**
 * The verify-email banner follows a text-size change made while it is up
 * (simulator 2026-10-24, shot 52).
 *
 * It kept the variant it was left in: unfolded at a large size, it stayed
 * unfolded after the size changed, so the next large size opened on the whole
 * sentence where a fresh open shows the short words. The unfolded state now
 * belongs to the scale it was opened at; a live change folds it, as a fresh
 * open at the new size is. At the default size the sentence is said by a view
 * that stays (`SaidWords`), and its drawn paragraph is new after a change.
 *
 * Real `useWindowDimensions` and `Dimensions.set`; the default reading is
 * restored after each test.
 */
import React from 'react';
import { Dimensions } from 'react-native';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../AuthProvider';
import { VerifyEmailBanner } from '../VerifyEmailBanner';
import { createFakeAuthRepository } from '../fakeAuthRepository';
import type { AuthUser } from '../types';
import en from '../../i18n/locales/en.json';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () =>
  jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions'),
);

const AX4 = 2.76;
const AX5 = 3.12;
const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};
const UNVERIFIED: AuthUser = {
  uid: 'u1', email: 'someone@example.com', emailVerified: false, displayName: null, providerIds: ['password'],
};

function setFontScale(fontScale: number) {
  const window = { width: 390, height: 844, scale: 3, fontScale };
  Dimensions.set({ window, screen: window });
}

afterEach(async () => {
  await cleanup();
  setFontScale(1);
});

async function show(fontScale: number) {
  setFontScale(fontScale);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: UNVERIFIED })} isDevBundle={false}>
          <VerifyEmailBanner>{null}</VerifyEmailBanner>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

const sentence = () => screen.getByTestId('m6-verify-sentence').props.children as string;
const toggle = () => screen.getByRole('button', { name: en.authVerifyBanner });

describe('the verify-email banner after a live text-size change', () => {
  it.each([[AX5, AX4], [AX5, 1, AX5]])('unfolded at %p×, it shows what a fresh open shows after the size changes (then %j)', async (opened, ...steps) => {
    await show(opened);
    expect(sentence()).toBe(en.authVerifyShort);
    await act(async () => { await fireEvent.press(toggle()); });
    expect(sentence()).toBe(en.authVerifyBanner);
    expect(screen.queryByTestId('verify-email-banner-full')).not.toBeNull();
    for (const scale of steps) {
      await act(async () => { setFontScale(scale); });
    }
    const last = steps[steps.length - 1]!;
    if (last === 1) {
      // The default size draws the whole sentence in its row, never a toggle.
      expect(sentence()).toBe(en.authVerifyBanner);
      expect(screen.queryByRole('button', { name: en.authVerifyBanner })).toBeNull();
    } else {
      // Folded, as a fresh open at this size is: the short words, the whole sentence said.
      expect(sentence()).toBe(en.authVerifyShort);
      expect(screen.queryByTestId('verify-email-banner-full')).toBeNull();
      expect(toggle().props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    }
  });

  it('unfolds and folds again at one size', async () => {
    await show(AX5);
    await act(async () => { await fireEvent.press(toggle()); });
    expect(toggle().props.accessibilityState).toEqual(expect.objectContaining({ expanded: true }));
    await act(async () => { await fireEvent.press(toggle()); });
    expect(toggle().props.accessibilityState).toEqual(expect.objectContaining({ expanded: false }));
    expect(sentence()).toBe(en.authVerifyShort);
  });

  it('at the default size the sentence is said by a view that stays; its drawn paragraph is new after each change', async () => {
    await show(1);
    const said = screen.getByTestId('m6-verify-sentence-said');
    expect(said.props.accessible).toBe(true);
    expect(said.props.accessibilityLabel).toBe(en.authVerifyBanner);
    const action = screen.getByTestId('m6-verify-action');
    let drawn = screen.getByTestId('m6-verify-sentence');
    expect(drawn.props.accessible).toBe(false);
    // 1.12 is still the default layout: the row stays, only the words change size.
    for (const scale of [1.12, 1]) {
      await act(async () => { setFontScale(scale); });
      expect(screen.getByTestId('m6-verify-sentence-said')).toBe(said);
      expect(screen.getByTestId('m6-verify-action')).toBe(action);
      expect(screen.getByTestId('m6-verify-sentence')).not.toBe(drawn);
      drawn = screen.getByTestId('m6-verify-sentence');
    }
  });
});

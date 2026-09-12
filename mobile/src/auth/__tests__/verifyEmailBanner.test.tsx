import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../AuthProvider';
import { RESEND_COOLDOWN_SECONDS, VerifyEmailBanner } from '../VerifyEmailBanner';
import { createFakeAuthRepository, type FakeAuthRepository } from '../fakeAuthRepository';
import type { AuthUser } from '../types';
import en from '../../i18n/locales/en.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const UNVERIFIED: AuthUser = {
  uid: 'u1',
  email: 'someone@example.com',
  emailVerified: false,
  displayName: null,
  providerIds: ['password'],
};

async function renderBanner(repository: FakeAuthRepository) {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={repository} isDevBundle={false}>
          <VerifyEmailBanner />
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('email verification banner', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('asks an unverified account to confirm, without blocking anything', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: UNVERIFIED }));
    expect(screen.getByText(en.authVerifyBanner)).toBeTruthy();
  });

  it('stays out of the way once the address is verified', async () => {
    await renderBanner(createFakeAuthRepository({ initialUser: { ...UNVERIFIED, emailVerified: true } }));
    expect(screen.queryByText(en.authVerifyBanner)).toBeNull();
  });

  it('never appears for a provider account with no address', async () => {
    await renderBanner(
      createFakeAuthRepository({
        initialUser: { ...UNVERIFIED, email: null, providerIds: ['apple.com'] },
      }),
    );
    expect(screen.queryByText(en.authVerifyBanner)).toBeNull();
  });

  it('resends once, then holds the button for the cooldown', async () => {
    const repository = createFakeAuthRepository({ initialUser: UNVERIFIED });
    await renderBanner(repository);
    await fireEvent.press(screen.getByLabelText(en.authVerifyResend));
    expect(repository.calls).toEqual([{ method: 'sendVerificationEmail' }]);

    // A second tap during the cooldown must not reach Firebase: it would only
    // trip the provider's own rate limit and lock the user out for longer.
    const cooling = screen.getByLabelText(`Resend in ${RESEND_COOLDOWN_SECONDS}s`);
    await fireEvent.press(cooling);
    expect(repository.calls).toHaveLength(1);
  });

  it('counts the cooldown down and offers the button again', async () => {
    const repository = createFakeAuthRepository({ initialUser: UNVERIFIED });
    await renderBanner(repository);
    await fireEvent.press(screen.getByLabelText(en.authVerifyResend));
    // One second at a time: each tick schedules the next only after React has
    // committed, so a single 60 s jump would fire exactly one timer.
    for (let second = 0; second < RESEND_COOLDOWN_SECONDS; second += 1) {
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
    }
    expect(screen.getByLabelText(en.authVerifyResend)).toBeTruthy();
  });
});

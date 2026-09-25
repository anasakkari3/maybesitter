import React, { useState } from 'react';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { AppProvider } from '../state/AppContext';
import { AuthProvider } from '../auth/AuthProvider';
import { createFakeAuthRepository } from '../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../api/auth';
import type { AuthUser } from '../auth/types';
import { CaptureProvider } from '../features/capture/CaptureProvider';
import { ConsentStep, type ConsentChoices } from '../features/onboarding/ConsentStep';
import { AboutYouReviewStep } from '../features/onboarding/AboutYouReviewStep';
import { RoutineStep } from '../features/onboarding/RoutineStep';
import { EMPTY_ANSWERS, type RoutineAnswers } from '../features/routine/routineProfile';
import { LegalLinks } from '../features/legal/LegalLinks';
import { CalendarScreen } from '../screens/CalendarScreen';
import { CaptureScreen } from '../screens/CaptureScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { EditProposalItemSheet } from '../features/capture/EditProposalItemSheet';
import * as commitmentEndpoints from '../api/endpoints/commitments';

import en from '../i18n/locales/en.json';
import ar from '../i18n/locales/ar.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const BASE = 'EXPO_PUBLIC_LEGAL_BASE_URL';

const USER: AuthUser = {
  uid: 'cal-user',
  email: 'a@b.c',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

describe('Mobile Accessibility Reality Audit Regressions', () => {
  let savedBase: string | undefined;

  beforeEach(() => {
    savedBase = process.env[BASE];
    process.env[BASE] = 'https://legal.example.com';
    onlineManager.setOnline(true);
    jest.spyOn(WebBrowser, 'openBrowserAsync').mockResolvedValue({ type: 'dismiss' } as never);
  });

  afterEach(() => {
    if (savedBase === undefined) delete process.env[BASE];
    else process.env[BASE] = savedBase;
    resetAuthForTests();
    jest.restoreAllMocks();
  });

  it('ConsentStep ChoiceButton renders accessibilityState.selected', async () => {
    const initialChoices: ConsentChoices = { ai: null, recommendations: false, analytics: false };
    function Harness() {
      const [choices, setChoices] = useState<ConsentChoices>(initialChoices);
      return (
        <SafeAreaProvider initialMetrics={METRICS}>
          <AppProvider>
            <ConsentStep
              choices={choices}
              onChange={setChoices}
              onContinue={() => {}}
              onBack={() => {}}
            />
          </AppProvider>
        </SafeAreaProvider>
      );
    }
    await render(<Harness />);
    const allowBtn = screen.queryByLabelText(en.obAiAllow) ?? screen.getByLabelText(ar.obAiAllow);
    const declineBtn = screen.queryByLabelText(en.obAiDecline) ?? screen.getByLabelText(ar.obAiDecline);
    expect(allowBtn.props.accessibilityState?.selected).toBe(false);
    expect(declineBtn.props.accessibilityState?.selected).toBe(false);
  });

  it('AboutYouReviewStep suggestion toggle has accessibilityRole="checkbox" and has hitSlop 12', async () => {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AboutYouReviewStep
            suggestions={[{ kind: 'goal', content: 'Call doctor', category: 'fitness_habit', targetDate: null, confidence: 0.9 }]}
            onSave={() => {}}
            onBack={() => {}}
          />
        </AppProvider>
      </SafeAreaProvider>
    );
    const checkbox = screen.getByTestId('about-review-tick-0');
    expect(checkbox.props.accessibilityRole).toBe('checkbox');
    expect(checkbox.props.accessibilityState?.checked).toBe(false);
    expect(checkbox.props.hitSlop).toBe(12);
  });

  it('RoutineStep choices render as accessibilityRole="radio" with checked state', async () => {
    function Harness() {
      const [answers, setAnswers] = useState<RoutineAnswers>({
        ...EMPTY_ANSWERS,
        sleep: 'early',
      });
      return (
        <SafeAreaProvider initialMetrics={METRICS}>
          <AppProvider>
            <RoutineStep
              answers={answers}
              onChange={(update) => setAnswers(prev => update(prev))}
              onContinue={() => {}}
              onBack={() => {}}
            />
          </AppProvider>
        </SafeAreaProvider>
      );
    }
    await render(<Harness />);
    const radios = screen.getAllByRole('radio');
    expect(radios.length).toBeGreaterThan(0);
    const checked = radios.filter(r => r.props.accessibilityState?.checked === true);
    expect(checked.length).toBe(1);
  });

  it('LegalLinks renders external links with accessibilityRole="link"', async () => {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <LegalLinks />
        </AppProvider>
      </SafeAreaProvider>
    );
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0]!.props.accessibilityRole).toBe('link');
  });

  it('CalendarScreen includes day number in day button accessibility label and hitSlop on settings', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const repository = createFakeAuthRepository({ initialUser: USER });
    setAuthRepository(repository);

    jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
    jest.spyOn(commitmentEndpoints, 'listUpcoming').mockResolvedValue({ items: [] } as never);

    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <AuthProvider repository={repository}>
            <AppProvider>
              <CaptureProvider>
                <CalendarScreen />
              </CaptureProvider>
            </AppProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );

    const settingsBtn = await screen.findByTestId('calendar-settings');
    expect(settingsBtn.props.hitSlop).toBe(8);

    await waitFor(() => expect(screen.getAllByTestId(/^calendar-day-/).length).toBeGreaterThan(0));
    const dayBtns = screen.getAllByTestId(/^calendar-day-/);
    const label = dayBtns[0]!.props.accessibilityLabel;
    expect(label).toBeTruthy();
    expect(/\d+/.test(label)).toBe(true);
  });

  it('CaptureScreen AI button has hitSlop 8 for touch target compliance', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const repository = createFakeAuthRepository({ initialUser: USER });
    setAuthRepository(repository);

    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <QueryClientProvider client={client}>
          <AuthProvider repository={repository}>
            <AppProvider>
              <CaptureProvider>
                <CaptureScreen />
              </CaptureProvider>
            </AppProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    );

    const aiBtn = screen.getByTestId('capture-ai-off');
    expect(aiBtn.props.hitSlop).toBe(8);
  });

  it('SignInScreen legal links declare accessibilityRole="link" and touch targets >= 44pt', async () => {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AuthProvider repository={createFakeAuthRepository()}>
          <AppProvider>
            <SignInScreen onEmail={() => {}} />
          </AppProvider>
        </AuthProvider>
      </SafeAreaProvider>
    );

    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) {
      expect(link.props.accessibilityRole).toBe('link');
      expect(link.props.hitSlop).toBe(8);
    }
  });

  it('EditProposalItemSheet sets accessibilityLabel, accessibilityRole, and dynamic date/time labels', async () => {
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <EditProposalItemSheet
            item={{
              itemId: 'item-1',
              title: 'Buy milk',
              priority: 'high',
              resolvedTime: '2026-09-28T14:00:00.000Z',
              needsClarification: false,
            }}
            edit={{
              localDateTime: '2026-09-28T14:00',
            }}
            onChange={() => {}}
            onClose={() => {}}
          />
        </AppProvider>
      </SafeAreaProvider>
    );

    const titleInput = screen.getByTestId('edit-item-title');
    expect(titleInput.props.accessibilityLabel).toBeTruthy();

    const switchBtn = screen.getByTestId('edit-item-no-time');
    expect(switchBtn.props.accessibilityRole).toBe('switch');
    expect(switchBtn.props.accessibilityLabel).toBeTruthy();

    const highPriority = screen.getByTestId('edit-item-priority-high');
    expect(highPriority.props.accessibilityRole).toBe('radio');
    expect(highPriority.props.accessibilityState?.checked).toBe(true);

    const lowPriority = screen.getByTestId('edit-item-priority-low');
    expect(lowPriority.props.accessibilityRole).toBe('radio');
    expect(lowPriority.props.accessibilityState?.checked).toBe(false);

    const dateBtn = screen.getByTestId('edit-item-pick-date');
    expect(dateBtn.props.accessibilityLabel).toMatch(/:/);

    const timeBtn = screen.getByTestId('edit-item-pick-time');
    expect(timeBtn.props.accessibilityLabel).toMatch(/:/);
  });
});

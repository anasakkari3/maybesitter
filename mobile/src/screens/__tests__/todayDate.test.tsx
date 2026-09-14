/**
 * The date on Today is today's (UC-1.R3 #156, UC-2.R3 #173).
 *
 * It was a literal in every locale file — "Thursday, 10 Sept", "الخميس، 10
 * أيلول", "יום חמישי, 10 בספטמבר" — so the header read the same on every day
 * of the year. The 2026-09-14 audit opened the app on a Monday and was told it
 * was a Thursday four days earlier, in all three languages, while the calendar
 * beside it showed the right week.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { render, screen, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '../../state/AppContext';
import { AuthProvider } from '../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests } from '../../api/auth';
import type { AuthUser } from '../../auth/types';
import { TodayScreen } from '../TodayScreen';
import * as commitmentEndpoints from '../../api/endpoints/commitments';
import en from '../../i18n/locales/en.json';
import ar from '../../i18n/locales/ar.json';
import he from '../../i18n/locales/he.json';

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const USER: AuthUser = {
  uid: 'today-date-user', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'],
};

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  jest.useFakeTimers({ doNotFake: ['nextTick'] });
});

afterEach(() => {
  jest.useRealTimers();
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

async function showOn(instant: string) {
  jest.setSystemTime(new Date(instant));
  jest.spyOn(commitmentEndpoints, 'listToday').mockResolvedValue({ items: [] } as never);
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AuthProvider repository={createFakeAuthRepository({ initialUser: USER })} isDevBundle={false}>
          <QueryClientProvider client={client}><TodayScreen /></QueryClientProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>,
  );
  await waitFor(() => expect(screen.queryByTestId('query-loading')).toBeNull());
}

describe('the date above "your day"', () => {
  it('is the day it actually is', async () => {
    // A Monday.
    await showOn('2026-09-14T09:00:00.000Z');
    expect(screen.queryByTestId('today-date')?.props.children).toContain('14');
    expect(screen.queryByText('Thursday, 10 Sept')).toBeNull();
  });

  it('changes when the day does', async () => {
    await showOn('2026-09-14T09:00:00.000Z');
    const monday = screen.getByTestId('today-date').props.children;
    screen.unmount();

    await showOn('2026-09-15T09:00:00.000Z');
    expect(screen.getByTestId('today-date').props.children).not.toBe(monday);
  });
});

describe('the locale files', () => {
  it('no longer carry a date of their own', () => {
    // A translated literal is a date that cannot be right twice.
    expect(en).not.toHaveProperty('dateToday');
    expect(ar).not.toHaveProperty('dateToday');
    expect(he).not.toHaveProperty('dateToday');
  });
});

/**
 * The capture request carries the *device's* timezone (UC-2.2, #162 step 4).
 *
 * The backend's deterministic time reconciliation recomputes every instant from
 * a local wall clock in this zone, so it is only as correct as the zone the
 * client sends. If the app sent UTC, or a hard-coded region, the reconciliation
 * would faithfully resolve "tomorrow at 9" to nine o'clock somewhere the user
 * is not.
 *
 * The archived Flutter client sent a hard-coded `Asia/Jerusalem`, which showed
 * the wrong wall time to everyone outside Israel. This test is the regression
 * guard for that class of mistake, and it drives the real hook and the real
 * endpoint rather than asserting on `deviceTimeZone()` alone — the value has to
 * reach the request body, which is a different claim.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Text } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClientProvider } from '@tanstack/react-query';
import { getCalendars } from 'expo-localization';
import { createAppQueryClient } from '../queryClient';
import { useCapture } from '../queries';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { setAuthRepository, resetAuthForTests } from '../auth';

// Hoisted above the imports by babel-plugin-jest-hoist, so '../i18n/timezone'
// sees the mock when it reaches for getCalendars.
jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Europe/Berlin' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const mockCalendars = getCalendars as unknown as jest.Mock;

/** Every request the app made, in order. */
let sent: Array<{ url: string; body: Record<string, unknown> }>;
let client: ReturnType<typeof createAppQueryClient>;

const PROPOSAL = {
  version: 'v1',
  proposalId: 'p1',
  status: 'proposed',
  items: [{ itemId: 'i1', title: 'Call the clinic', resolvedTime: '2026-09-15T07:00:00.000Z', needsClarification: false }],
};

beforeEach(() => {
  client = createAppQueryClient();
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'alice', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
  sent = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: { body?: string }) => {
    sent.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
    return { status: 200, text: async () => JSON.stringify(PROPOSAL) };
  }) as never;
});

afterEach(() => {
  client.clear();
  resetAuthForTests();
  jest.restoreAllMocks();
});

/** Fires one capture and reports when it has landed. */
function CaptureProbe() {
  const capture = useCapture();
  return (
    <Text testID="probe" onPress={() => capture.mutate('call the clinic tomorrow at 9')}>
      {capture.isSuccess ? 'done' : 'idle'}
    </Text>
  );
}

async function captureOnce() {
  // `render` is async in RNTL 14; without the await, `screen` is still empty
  // and the press lands on nothing.
  await render(
    <QueryClientProvider client={client}>
      <CaptureProbe />
    </QueryClientProvider>,
  );
  // fireEvent wraps the press in act itself; wrapping it in act as well
  // produces overlapping scopes, which React reports and Jest then fails on.
  fireEvent.press(screen.getByTestId('probe'));
  await waitFor(() => expect(screen.getByTestId('probe')).toHaveTextContent('done'));
  return sent.find(request => request.url.endsWith('/api/mobile/capture'));
}

describe('the capture request timezone', () => {
  it('carries the device IANA zone, not UTC and not a hard-coded region', async () => {
    mockCalendars.mockReturnValue([{ timeZone: 'Europe/Berlin' }]);

    const request = await captureOnce();

    expect(request).toBeDefined();
    expect(request!.body.timezone).toBe('Europe/Berlin');
    expect(request!.body.timezone).not.toBe('UTC');
    // The zone the archived Flutter client hard-coded.
    expect(request!.body.timezone).not.toBe('Asia/Jerusalem');
    expect(request!.body.text).toBe('call the clinic tomorrow at 9');
    // A reference time is sent too: the server resolves "tomorrow" against it.
    expect(typeof request!.body.referenceTime).toBe('string');
  });

  it('follows the device when the zone is a different one', async () => {
    // Not a fixed expectation of Berlin: the point is that whatever the device
    // reports is what is sent.
    mockCalendars.mockReturnValue([{ timeZone: 'America/New_York' }]);

    const request = await captureOnce();

    expect(request!.body.timezone).toBe('America/New_York');
  });

  it('falls back to UTC rather than guessing a region when the device is unreadable', async () => {
    mockCalendars.mockReturnValue([{ timeZone: 'Mars/Phobos' }]);

    const request = await captureOnce();

    // UTC is obviously wrong; a guessed region is quietly wrong.
    expect(request!.body.timezone).toBe('UTC');
  });
});

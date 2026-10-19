import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  ACCOUNT_A,
  NOW,
  initialState,
  prepare,
  press,
  showIntelligence,
  teardown,
  waitForRequest,
  type M5aHarness,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5aHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

describe('R4.1 monitoring enrolment and backfill', () => {
  it('M5A-R4-001 fresh enable shows monitor-info before POST and sends enrolM5 plus timezone', async () => {
    harness = await prepare();
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-monitor')).not.toBeNull());
    await press('intelligence-gmail-monitor');

    expect(screen.queryByTestId('monitor-info')).not.toBeNull();
    expect(harness.server.matching('POST', /\/gmail\/monitor$/)).toHaveLength(0);
    await press('monitor-info-confirm');
    const request = await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);
    expect(request.body).toEqual({ enabled: true, enrollM5: true, timezone: 'Asia/Jerusalem' });
  });

  it('R4.1 successful enable offers backfill; yes starts a new backfill scan', async () => {
    harness = await prepare();
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-monitor')).not.toBeNull());
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitFor(() => expect(screen.queryByTestId('backfill-offer')).not.toBeNull());
    await press('backfill-yes');
    const request = await waitForRequest(harness, 'POST', /\/gmail\/scan$/);

    expect(request.body).toMatchObject({ m5: true, intent: 'new', origin: 'backfill', timezone: 'Asia/Jerusalem' });
  });

  it('R4.1 backfill no dismisses without a scan request', async () => {
    harness = await prepare();
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-monitor')).not.toBeNull());
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitFor(() => expect(screen.queryByTestId('backfill-no')).not.toBeNull());
    await press('backfill-no');

    expect(screen.queryByTestId('backfill-offer')).toBeNull();
    expect(harness.server.matching('POST', /\/gmail\/scan$/)).toHaveLength(0);
  });

  it('M5A-R35-004 pre-M5 enabled monitor shows upgrade once; no is remembered per uid with no request', async () => {
    harness = await prepare('en', initialState({
      monitor: { enabled: true, lastSuccessAt: null, error: null, m5Enrolled: false, waiting: null },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('monitor-upgrade-notice')).not.toBeNull());
    await press('monitor-upgrade-no');
    expect(harness.server.matching('POST', /\/gmail\/monitor$/)).toHaveLength(0);

    await cleanup();
    harness.client.clear();
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-monitor')).not.toBeNull());
    expect(screen.queryByTestId('monitor-upgrade-notice')).toBeNull();
    expect(await AsyncStorage.getAllKeys()).toContainEqual(expect.stringContaining(ACCOUNT_A.uid));
  });

  it('M5A-R35-004 upgrade yes enrolls the existing monitor with timezone but does not toggle it', async () => {
    harness = await prepare('en', initialState({
      monitor: { enabled: true, lastSuccessAt: null, error: null, m5Enrolled: false, waiting: null },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('monitor-upgrade-yes')).not.toBeNull());
    await press('monitor-upgrade-yes');
    const request = await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);

    expect(request.body).toEqual({ enabled: true, enrollM5: true, timezone: 'Asia/Jerusalem' });
  });

  it('M5A-R29-002 monitor quota wait uses the shared wait line', async () => {
    harness = await prepare('en', initialState({
      monitor: {
        enabled: true, lastSuccessAt: '2030-03-29T08:00:00.000Z', error: null, m5Enrolled: true,
        waiting: { reason: 'daily_ai_limit', resumesAt: '2030-03-30T00:00:00.000Z' },
      },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-wait')).not.toBeNull());
    expect(screen.getByTestId('email-scan-wait')).toHaveTextContent(/daily limit/i);
  });

  it('M5A-R35-004 held no_timezone causes the enabled monitor POST to resend the device timezone', async () => {
    harness = await prepare('en', initialState({
      monitor: { enabled: true, lastSuccessAt: null, error: null, m5Enrolled: true, waiting: null },
      scanDaily: { status: 'held', reason: 'no_timezone', heldAt: '2030-03-29T08:00:00.000Z' },
    }));
    await showIntelligence(harness);
    const request = await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);

    expect(request.body).toEqual({ enabled: true, enrollM5: true, timezone: 'Asia/Jerusalem' });
    expect(screen.queryByTestId('email-scan-daily')).not.toBeNull();
  });
});


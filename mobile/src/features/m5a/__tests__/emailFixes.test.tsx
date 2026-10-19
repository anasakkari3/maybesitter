/**
 * The email-side findings of Codex's Task A inspection (M5A-A-REV-010/011/012).
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  addedItem,
  completeScan,
  initialState,
  prepare,
  press,
  showIntelligence,
  teardown,
  waitForRequest,
  type M5aHarness,
} from '../../../__acceptance__/m5a/harness';

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

describe('email status says what happened', () => {
  it('REV-010: a failed daily sweep names the failure, not a summary', async () => {
    harness = await prepare('en', initialState({
      scanDaily: {
        scanId: 'scan-daily-1', status: 'failed', day: '2030-03-28', failure: 'reconnect_needed',
        from: '2030-03-27T22:00:00.000Z', until: '2030-03-28T22:00:00.000Z',
        startedAt: '2030-03-29T03:00:00.000Z', failedAt: '2030-03-29T03:02:00.000Z',
        messagesRead: 2, messagesUnavailable: 0, messagesTrimmed: 0, observationsFound: 0, addedFromEmail: 0,
      },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-daily')).not.toBeNull());
    expect(screen.getByTestId('email-scan-daily')).toHaveTextContent(/Google needs reconnecting/);
    expect(screen.getByTestId('email-scan-daily')).not.toHaveTextContent(/Last daily check/);
  });

  it('REV-010: a completed scan says when it started and how many were added', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan({ addedFromEmail: 2 }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/Started /);
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/\b2 added from your own replies/);
  });

  it('REV-012: each added row shows when the commitment is', async () => {
    harness = await prepare('en', initialState({ added: [addedItem()] }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-when-auto-1')).not.toBeNull());
    expect(screen.getByTestId('added-when-auto-1')).toHaveTextContent(/11:00|Tomorrow/);
  });
});

describe('the backfill offer', () => {
  it('REV-011: is not offered while a scan of the last day exists', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan() }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    await press('intelligence-gmail-monitor');
    await press('monitor-info-confirm');
    await waitForRequest(harness, 'POST', /\/gmail\/monitor$/);
    expect(screen.queryByTestId('backfill-offer')).toBeNull();
  });
});

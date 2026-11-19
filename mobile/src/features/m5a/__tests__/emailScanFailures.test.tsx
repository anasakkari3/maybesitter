/**
 * Wave E (QA audit de7fcb8, Google-connected pass 2026-11-19): what the email
 * scan says when a request around it fails.
 *
 * - CXA9.3: the status read fails → the block vanished, or a stale line
 *   stayed frozen, with nothing said.
 * - CXA9.4: the start's answer is lost (timeout / network) while the server
 *   already admitted the scan → the app said "can't reach" over a running scan.
 * - CXA9.5: «كمّل من وين وقفت» fails → nothing was said.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  failedScan,
  initialState,
  prepare,
  press,
  runningScan,
  showGoogle,
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

const SCAN = /\/intelligence\/sources\/gmail\/scan$/;

describe('CXA9.3: a failed status read is said, with a way to try again', () => {
  it.each([
    { name: 'intelligence panel', show: showIntelligence },
    { name: 'Google screen', show: showGoogle },
  ])('$name: the overview GET fails on a fresh load', async ({ show }) => {
    harness = await prepare('en', initialState(), request => (
      request.method === 'GET' && SCAN.test(request.path)
        ? { status: 500, body: { success: false, error: 'internal' } }
        : undefined
    ));
    await show(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status-failed')).not.toBeNull());
    expect(screen.getByTestId('email-scan-status-failed')).toHaveTextContent(/scan/i);
    expect(screen.queryByTestId('email-scan-status-retry')).not.toBeNull();

    // Trying again reads the status again, and a good answer replaces the notice.
    harness.server.handler = undefined;
    harness.server.state.scanManual = runningScan({ messagesRead: 3 });
    const before = harness.server.matching('GET', SCAN).length;
    await press('email-scan-status-retry');
    await waitForRequest(harness, 'GET', SCAN, before + 1);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status-failed')).toBeNull());
    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/3/);
  });
});

describe('CXA9.4: a lost start answer does not contradict a scan the server is running', () => {
  it('a network failure on the start, with the scan running on the server, shows the scan and no error', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.method === 'POST' && SCAN.test(request.path)) {
        // The server admitted it; only the answer never arrived.
        harness!.server.state.scanManual = runningScan({ messagesRead: 2 });
        throw new Error('connection dropped');
      }
      return undefined;
    });
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await press('email-scan-confirm-go');
    await waitForRequest(harness, 'POST', SCAN);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/2/));
    expect(screen.queryByTestId('email-scan-error')).toBeNull();
  });

  it('a network failure with no scan on the server still says it did not start', async () => {
    harness = await prepare('en', initialState(), request => {
      if (request.method === 'POST' && SCAN.test(request.path)) throw new Error('connection dropped');
      return undefined;
    });
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');
    await press('email-scan-confirm-go');
    await waitFor(() => expect(screen.queryByTestId('email-scan-error')).not.toBeNull());
  });
});

describe('CXA9.5: a failed resume is said', () => {
  it('the resume POST fails → a notice under the button; the button stays', async () => {
    harness = await prepare('en', initialState({ scanManual: failedScan('source_unavailable') }), request => (
      request.method === 'POST' && SCAN.test(request.path)
        ? { status: 502, body: { success: false, error: 'google_unavailable', reason: 'google_unavailable' } }
        : undefined
    ));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-resume')).not.toBeNull());
    expect(screen.queryByTestId('email-scan-resume-error')).toBeNull();
    await press('email-scan-resume');
    await waitForRequest(harness, 'POST', SCAN);
    await waitFor(() => expect(screen.queryByTestId('email-scan-resume-error')).not.toBeNull());
    expect(screen.queryByTestId('email-scan-resume')).not.toBeNull();
  });
});

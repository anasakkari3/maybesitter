import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanup, screen, waitFor } from '@testing-library/react-native';
import {
  NOW,
  addedItem,
  commitmentWithProvenance,
  completeScan,
  failedScan,
  initialState,
  prepare,
  press,
  runningScan,
  showAddedDetail,
  showGoogle,
  showIntelligence,
  teardown,
  waitForRequest,
  type M5aHarness,
  type RouteHandler,
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

describe('R2.3 one M5a email scan', () => {
  it.each([
    { name: 'intelligence panel', show: showIntelligence },
    { name: 'Google screen', show: showGoogle },
  ])('M5A-R5-003 $name opens email-scan-confirm before any request and confirm sends the versioned new intent', async ({ show }) => {
    harness = await prepare();
    await show(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-button')).not.toBeNull());
    await press('email-scan-button');

    expect(screen.queryByTestId('email-scan-confirm')).not.toBeNull();
    expect(harness.server.matching('POST', /\/intelligence\/sources\/gmail\/scan$/)).toHaveLength(0);
    expect(harness.server.matching('POST', /\/integrations\/google\/gmail\/scan$/)).toHaveLength(0);

    await press('email-scan-confirm-go');
    const request = await waitForRequest(harness, 'POST', /\/intelligence\/sources\/gmail\/scan$/);
    expect(request.body).toMatchObject({ m5: true, intent: 'new', timezone: 'Asia/Jerusalem' });
  });

  it('M5A-R40-001 resume sends expectedScanId and does not start a new window', async () => {
    harness = await prepare('en', initialState({
      scanManual: failedScan('analysis_unavailable'),
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-resume')).not.toBeNull());
    await press('email-scan-resume');
    const request = await waitForRequest(harness, 'POST', /\/intelligence\/sources\/gmail\/scan$/);

    expect(request.body).toEqual({ m5: true, intent: 'resume', expectedScanId: 'scan-manual-1' });
  });

  it('M5A-R5-003 capability false keeps both legacy entry points and request shapes unchanged', async () => {
    harness = await prepare('en', initialState({ emailSources: false }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-gmail-scan')).not.toBeNull());
    await press('intelligence-gmail-scan');
    await press('intelligence-gmail-scan-confirm');
    const panel = await waitForRequest(harness, 'POST', /\/intelligence\/sources\/gmail\/scan$/);
    expect(panel.body).toEqual({});

    await cleanup();
    harness.client.clear();
    await showGoogle(harness);
    await waitFor(() => expect(screen.queryByTestId('google-gmail-scan')).not.toBeNull());
    await press('google-gmail-scan');
    const google = await waitForRequest(harness, 'POST', /\/integrations\/google\/gmail\/scan$/);
    expect(google.body).not.toMatchObject({ m5: true });
    expect(harness.server.matching('GET', /\/capabilities\/m5a$/).length).toBeGreaterThanOrEqual(2);
  });
});

describe('R2.2 shared email status line', () => {
  it('R2.3 renders a running scan and its read count from GET', async () => {
    harness = await prepare('en', initialState({ scanManual: runningScan({ messagesRead: 4 }) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());

    expect(screen.getByTestId('email-scan-status')).toHaveTextContent(/\b4\b/);
    expect(screen.getByTestId('email-scan-status').props.accessibilityLiveRegion).toBe('polite');
  });

  it('R2.3 renders complete counts, trimmed and unavailable mail', async () => {
    harness = await prepare('en', initialState({ scanManual: completeScan() }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());

    const status = screen.getByTestId('email-scan-status');
    expect(status).toHaveTextContent(/\b7\b/);
    expect(status).toHaveTextContent(/\b1\b/);
    expect(status).toHaveTextContent(/\b2\b/);
    expect(status).toHaveTextContent(/\b3\b/);
  });

  it.each([
    { failure: 'reconnect_needed' as const, testID: 'email-scan-reconnect' },
    { failure: 'source_unavailable' as const, testID: 'email-scan-resume' },
    { failure: 'analysis_unavailable' as const, testID: 'email-scan-resume' },
    { failure: 'monitoring_off' as const, testID: 'email-scan-resume' },
  ])('R2.3 failed $failure renders the recovery control $testID', async ({ failure, testID }) => {
    harness = await prepare('en', initialState({ scanManual: failedScan(failure) }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-status')).not.toBeNull());
    expect(screen.queryByTestId(testID)).not.toBeNull();
  });

  it.each([
    { reason: 'daily_ai_limit' as const, resumesAt: '2030-03-30T00:00:00.000Z' },
    { reason: 'rate_limit' as const, resumesAt: '2030-03-29T09:01:00.000Z' },
  ])('M5A-R30-004 renders a $reason wait distinctly', async ({ reason, resumesAt }) => {
    harness = await prepare('en', initialState({
      scanManual: runningScan({ waiting: { reason, resumesAt } }),
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-wait')).not.toBeNull());
    expect(screen.queryByTestId(`email-scan-wait-${reason}`)).not.toBeNull();
  });

  it('M5A-R39-004 renders the accepted queued window and keeps it after navigation', async () => {
    harness = await prepare('en', initialState({
      scanManual: runningScan(),
      scanQueued: {
        scanId: 'scan-queued-1',
        origin: 'backfill', from: '2030-03-22T09:00:00.000Z', until: NOW.toISOString(),
        acceptedAt: '2030-03-29T08:45:00.000Z',
      },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-queued')).not.toBeNull());
    await cleanup();
    harness.client.clear();
    await showGoogle(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-queued')).not.toBeNull());

    expect(harness.server.matching('GET', /\/intelligence\/sources\/gmail\/scan$/).length).toBeGreaterThanOrEqual(2);
  });

  it('R2.3 renders a completed daily scan with its day and count', async () => {
    harness = await prepare('en', initialState({
      scanDaily: {
        scanId: 'scan-daily-1', status: 'complete', day: '2030-03-28',
        from: '2030-03-27T22:00:00.000Z', until: '2030-03-28T22:00:00.000Z',
        startedAt: '2030-03-29T03:00:00.000Z', finishedAt: '2030-03-29T03:05:00.000Z',
        messagesRead: 6, messagesUnavailable: 0, messagesTrimmed: 0,
        observationsFound: 2, addedFromEmail: 1,
      },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-daily')).not.toBeNull());

    expect(screen.getByTestId('email-scan-daily')).toHaveTextContent(/\b6\b/);
  });

  it('M5A-R35-004 renders daily held without inventing a day', async () => {
    harness = await prepare('en', initialState({
      scanDaily: {
        status: 'held', reason: 'no_timezone', heldAt: '2030-03-29T08:00:00.000Z',
      },
    }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('email-scan-daily')).not.toBeNull());
    expect(screen.getByTestId('email-scan-daily')).not.toHaveTextContent(/2030-03-2[0-9]/);
  });
});

describe('R3.5 added from email', () => {
  it('R3.5 renders the card from GET /added and removes through DELETE then refetches', async () => {
    harness = await prepare('en', initialState({ added: [addedItem()] }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-card')).not.toBeNull());
    expect(screen.queryByTestId('added-row-auto-1')).not.toBeNull();
    await press('added-remove-auto-1');
    await waitForRequest(harness, 'DELETE', /\/intelligence\/added\/auto-1$/);
    await waitFor(() => expect(harness!.server.matching('GET', /\/intelligence\/added$/).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByTestId('added-row-auto-1')).toBeNull();
  });

  it('M5A-R38-005 added-more consumes nextCursor and appends the next page', async () => {
    const first = addedItem();
    const second = addedItem({ autoAddId: 'auto-2', commitmentId: 'added-2', title: 'Second item' });
    const handler: RouteHandler = request => {
      if (request.path !== '/api/mobile/intelligence/added') return undefined;
      if (request.query.get('cursor') === 'next-1') {
        return { status: 200, body: { success: true, items: [second], nextCursor: null } };
      }
      return { status: 200, body: { success: true, items: [first], nextCursor: 'next-1' } };
    };
    harness = await prepare('en', initialState(), handler);
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-more')).not.toBeNull());
    await press('added-more');
    const secondPage = await waitForRequest(harness, 'GET', /\/intelligence\/added$/, 2);

    expect(secondPage.query.get('cursor')).toBe('next-1');
    expect(secondPage.query.get('limit')).toBe('20');
    expect(screen.queryByTestId('added-row-auto-1')).not.toBeNull();
    await waitFor(() => expect(screen.queryByTestId('added-row-auto-2')).not.toBeNull());
  });

  it.each(['done', 'dropped', 'archived'] as const)('M5A-R6-005 %s rows show status and no remove action', async status => {
    harness = await prepare('en', initialState({ added: [addedItem({ status, removable: false })] }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-row-auto-1')).not.toBeNull());

    expect(screen.queryByTestId('added-remove-auto-1')).toBeNull();
    expect(screen.queryByTestId(`added-status-auto-1-${status}`)).not.toBeNull();
  });

  it('M5A-R6-005 a 409 edited removal keeps the row and renders added-edited', async () => {
    harness = await prepare('en', initialState({ added: [addedItem()] }), request => {
      if (request.path === '/api/mobile/intelligence/added/auto-1' && request.method === 'DELETE') {
        return { status: 409, body: { success: false, error: 'edited' } };
      }
      return undefined;
    });
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-remove-auto-1')).not.toBeNull());
    await press('added-remove-auto-1');
    await waitForRequest(harness, 'DELETE', /\/intelligence\/added\/auto-1$/);

    expect(screen.queryByTestId('added-row-auto-1')).not.toBeNull();
    expect(screen.queryByTestId('added-edited-auto-1')).not.toBeNull();
  });

  it('M5A-R54-004 removable false renders added-edited instead of a remove action', async () => {
    harness = await prepare('en', initialState({ added: [addedItem({ removable: false })] }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-edited-auto-1')).not.toBeNull());
    expect(screen.queryByTestId('added-remove-auto-1')).toBeNull();
  });

  it('R3.5 detail provenance appears only when addedFrom is present', async () => {
    harness = await prepare();
    await showAddedDetail(harness);
    await waitFor(() => expect(screen.queryByTestId('details-title')).not.toBeNull());
    expect(screen.queryByTestId('added-from-line')).not.toBeNull();

    await cleanup();
    harness.client.clear();
    harness.server.handler = request => {
      if (request.path === '/api/mobile/commitments/added-1') {
        return {
          status: 200,
          body: commitmentWithProvenance(false),
          headers: { etag: 'W/"m5a-v2"' },
        };
      }
      return undefined;
    };
    await showAddedDetail(harness);
    await waitFor(() => expect(screen.queryByTestId('details-title')).not.toBeNull());
    expect(screen.queryByTestId('added-from-line')).toBeNull();
  });

  it('M5A-002 capability off still renders existing added data and its removal', async () => {
    harness = await prepare('en', initialState({ emailSources: false, added: [addedItem()] }));
    await showIntelligence(harness);
    await waitFor(() => expect(screen.queryByTestId('added-card')).not.toBeNull());
    expect(screen.queryByTestId('added-remove-auto-1')).not.toBeNull();
    await press('added-remove-auto-1');
    await waitForRequest(harness, 'DELETE', /\/intelligence\/added\/auto-1$/);
  });
});


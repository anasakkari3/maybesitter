import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { NOW, initialState, prepare, showKnows, teardown, type M5bHarness } from '../../../__acceptance__/m5b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/**
 * M5B1-016: a failed paragraph is not asked for again within the mount. Each
 * request sends the person's rows to the model, so reconnecting or coming
 * back to the app must not spend another; only a real memory change
 * (prefix invalidation) asks again.
 */
let harness: M5bHarness | undefined;
const SUMMARY = /^\/api\/mobile\/memory\/summary$/;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

describe('M5B1-016 no refetch after a failed summary', () => {
  it('reconnect and foreground issue no second summary request', async () => {
    harness = await prepare('en', initialState(), request => request.path === '/api/mobile/memory/summary'
      ? { status: 500, body: { success: false, error: 'internal_error' } }
      : undefined);
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
    expect(harness.server.matching('GET', SUMMARY)).toHaveLength(1);

    await act(async () => { onlineManager.setOnline(false); });
    await act(async () => { onlineManager.setOnline(true); });
    await act(async () => { focusManager.setFocused(false); });
    await act(async () => { focusManager.setFocused(true); });
    await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });

    expect(harness.server.matching('GET', SUMMARY)).toHaveLength(1);
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
  });
});

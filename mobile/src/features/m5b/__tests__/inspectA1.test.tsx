import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { queryKeys } from '../../../api/queries';
import { m5bCapabilitiesKey } from '../capabilities';
import { ACCOUNT_A, NOW, Providers, TODAY, initialState, prepare, readySummary, showKnows, teardown, type M5bHarness } from '../../../__acceptance__/m5b/harness';
import { render } from '@testing-library/react-native';
import { KnowsScreen } from '../../settings/KnowsScreen';
import { PlanScreen } from '../../../screens/PlanScreen';
import { ReadinessSettingsScreen } from '../../settings/ReadinessSettingsScreen';
import { TodayScreen } from '../../../screens/TodayScreen';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** Regressions for Codex's Task A inspection r1 (`runs/m5b1-inspectA1`). */
let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

describe('Task A inspection r1', () => {
  it('M5B-A-001 a failed refetch after a memory change drops the old paragraph and shows the rows', async () => {
    let failSummary = false;
    harness = await prepare('en', initialState(), request => request.path === '/api/mobile/memory/summary' && failSummary
      ? { status: 500, body: { success: false, error: 'internal_error' } }
      : undefined);
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-summary')).not.toBeNull());
    expect(screen.queryByTestId('memory-summary-title')).not.toBeNull();

    failSummary = true;
    await act(async () => { await harness!.client.invalidateQueries({ queryKey: queryKeys.memory(ACCOUNT_A.uid) }); });
    await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });

    await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('memory-summary')).toBeNull();
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
  });

  it('M5B-A-004 a failed refetch of the list keeps the card, its rows and the disclosure', async () => {
    let failList = false;
    harness = await prepare('en', initialState({ summary: { status: 'unavailable' } }), request =>
      request.path === '/api/mobile/memory' && request.method === 'GET' && failList
        ? { status: 500, body: { success: false, error: 'internal_error' } }
        : undefined);
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());

    failList = true;
    // Not awaited: the list's two retries wait on the fake clock advanced below.
    await act(async () => { void harness!.client.invalidateQueries({ queryKey: queryKeys.memory(ACCOUNT_A.uid) }); });
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(harness.client.getQueryState(queryKeys.memory(ACCOUNT_A.uid))?.status).toBe('error');

    expect(screen.queryByTestId('memory-section')).not.toBeNull();
    expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull();
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
  });

  it('M5B-A-002 a failed capability refetch after `true` draws no M5b surface', async () => {
    let failProbe = false;
    harness = await prepare('en', initialState({ summary: readySummary('en') }), request =>
      request.path === '/api/mobile/capabilities/m5b' && failProbe
        ? { status: 500, body: { success: false, error: 'internal_error' } }
        : undefined);
    await render(
      <Providers harness={harness}>
        <KnowsScreen onBack={() => {}} onMemory={() => {}} />
        <PlanScreen date={TODAY} onBack={() => {}} />
        <ReadinessSettingsScreen onBack={() => {}} />
        <TodayScreen />
      </Providers>,
    );
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-energy-effect')).not.toBeNull());

    failProbe = true;
    await act(async () => { await harness!.client.refetchQueries({ queryKey: m5bCapabilitiesKey(ACCOUNT_A.uid) }); });

    await waitFor(() => expect(screen.queryAllByTestId(/^m5b-/)).toHaveLength(0));
    expect(screen.queryByTestId('memory-summary-disclosure')).toBeNull();
  });
});

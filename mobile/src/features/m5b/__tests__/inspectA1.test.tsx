import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { queryKeys } from '../../../api/queries';
import { m5bCapabilitiesKey } from '../capabilities';
import { ACCOUNT_A, NOW, Providers, TODAY, initialState, prepare, readySummary, showKnows, showPlan, showToday, teardown, type M5bHarness } from '../../../__acceptance__/m5b/harness';
import { fireEvent } from '@testing-library/react-native';
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

describe('Task A inspection r2 and the simulator pass', () => {
  it('M5B-A2-001 a question hidden last night comes back after midnight without a remount', async () => {
    harness = await prepare('en', initialState({ energy: { source: 'none', level: null, band: null, changedPick: false } }));
    await showToday(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-today-energy-hide'));
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).toBeNull());

    await act(async () => { await jest.advanceTimersByTimeAsync(24 * 60 * 60_000); });
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
  });

  it('M5B-A2-002 + SIM-M5B-01 the saved line is screen-reader only and does not suppress a later question', async () => {
    harness = await prepare('en', initialState({ energy: { source: 'none', level: null, band: null, changedPick: false } }));
    await showToday(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
    harness.server.state.energy = { source: 'check_in', level: 2, band: 'low', changedPick: false };
    await fireEvent.press(screen.getByTestId('m5b-today-energy-2'));
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy')).not.toBeNull());
    // One visible copy of the line; the confirmation's copy sits in the
    // screen-reader-only region (1×1, clipped), then clears itself.
    expect(screen.getByTestId('m5b-today-energy-saved').props.style).toEqual(expect.objectContaining({ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }));
    await act(async () => { await jest.advanceTimersByTimeAsync(5_000); });
    expect(screen.getAllByText('Energy now: 2 of 5')).toHaveLength(1);

    // The reading ages out; the next answer has none, and the question returns.
    harness.server.state.energy = { source: 'none', level: null, band: null, changedPick: false };
    await act(async () => { await harness!.client.invalidateQueries({ queryKey: ['user', ACCOUNT_A.uid, 'nextStep'] }); });
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
  });

  it('M5B-A2-003 row actions wrap with the capability off too', async () => {
    harness = await prepare('ar', initialState({ memoryLearning: false }));
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-edit-memory-1')).not.toBeNull());
    const row = screen.getByTestId('memory-edit-memory-1').parent;
    expect(row?.props.style).toEqual(expect.objectContaining({ flexWrap: 'wrap' }));
    expect(screen.queryAllByTestId(/^m5b-/)).toHaveLength(0);
  });

  it('SIM-M5B-02 the empty Plan shows the check-in already given as chosen', async () => {
    harness = await prepare('en', initialState({ plan: null }));
    await showPlan(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-energy-2')).not.toBeNull());
    await waitFor(() => expect(screen.getByTestId('m5b-plan-energy-2').props.accessibilityState).toMatchObject({ selected: true }));
  });

  it('M5B-A3-001 a save the server does not yet reflect never hides the question', async () => {
    harness = await prepare('en', initialState({ energy: { source: 'none', level: null, band: null, changedPick: false } }));
    await showToday(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-today-energy-2'));
    await waitFor(() => expect(harness!.server.matching('PUT', /^\/api\/mobile\/readiness$/)).toHaveLength(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    // The next step still says no reading (expired, or not yet refetched): the question stays.
    expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull();
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });
    expect(screen.queryByTestId('m5b-today-energy-question')).not.toBeNull();
  });
});

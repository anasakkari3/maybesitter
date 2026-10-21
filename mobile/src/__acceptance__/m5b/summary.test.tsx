import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Btn } from '../../ui/primitives';
import { queryKeys, useIntelligenceDecided, usePutRoutine } from '../../api/queries';
import { KnowsScreen } from '../../features/settings/KnowsScreen';
import {
  ACCOUNT_A,
  NOW,
  Providers,
  ZONE,
  initialState,
  prepare,
  readySummary,
  showKnows,
  teardown,
  type M5bHarness,
  type RouteReply,
  type RouteHandler,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

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

function WriterProbe({ kind }: { kind: 'routine' | 'intelligence' }) {
  const routine = usePutRoutine();
  const intelligence = useIntelligenceDecided();
  return (
    <Btn
      testID="m5b-writer-probe"
      label="writer"
      onPress={() => {
        if (kind === 'intelligence') intelligence();
        else routine.mutate({
          timezone: ZONE, sleepWindow: null, focusWindows: [], fixedCommitmentWindows: [],
          preferredReminderIntensity: 'softAwareness', quietHours: null, surveySkipped: true,
        });
      }}
    ><></></Btn>
  );
}

async function renderWithWriter(kind: 'routine' | 'intelligence') {
  await render(
    <Providers harness={harness!}>
      <WriterProbe kind={kind} />
      <KnowsScreen onBack={() => {}} onMemory={() => {}} />
    </Providers>,
  );
}

describe('M5b summary disclosure and lifecycle', () => {
  it.each(['ar', 'en', 'he'] as const)('R1.2 %s renders one isolated paragraph and keeps disclosure after the request', async language => {
    harness = await prepare(language, initialState({ summary: readySummary(language) }));
    await showKnows(harness);

    await waitFor(() => expect(screen.queryByTestId('memory-summary')).not.toBeNull());
    expect(screen.getAllByTestId('memory-summary')).toHaveLength(1);
    expect(JSON.stringify(screen.getByTestId('memory-summary').props.children)).toMatch(/[\u2066-\u2069]/);
    expect(screen.queryByTestId('memory-summary-more')).not.toBeNull();
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
    const request = harness.server.matching('GET', /^\/api\/mobile\/memory\/summary$/)[0];
    expect(request?.query.get('language')).toBe(language);
  });

  it('M5B1-011 mounts the disclosure before issuing the summary GET and keeps it while loading', async () => {
    let disclosureWasMounted = false;
    const handler: RouteHandler = request => {
      if (request.path !== '/api/mobile/memory/summary') return undefined;
      disclosureWasMounted = screen.queryByTestId('memory-summary-disclosure') !== null;
      return new Promise(() => {});
    };
    harness = await prepare('en', initialState(), handler);
    await showKnows(harness);

    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory\/summary$/)).toHaveLength(1));
    expect(disclosureWasMounted).toBe(true);
    expect(screen.queryByTestId('memory-summary-loading')).not.toBeNull();
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
  });

  const FAILURES: [string, () => Promise<RouteReply>][] = [
    ['server unavailable', async () => ({ status: 200, body: { success: true, summary: { status: 'unavailable' } } })],
    ['HTTP 500', async () => ({ status: 500, body: { success: false, error: 'internal_error' } })],
    ['network error', async () => { throw new TypeError('network failed'); }],
  ];

  it.each(FAILURES)('M5B1-011 %s falls back to rows, retains disclosure, and does not retry', async (_case, answer) => {
    harness = await prepare('en', initialState(), request => request.path === '/api/mobile/memory/summary' ? answer() : undefined);
    await showKnows(harness);
    await act(async () => { await jest.advanceTimersByTimeAsync(10_000); });

    await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
    expect(harness.server.matching('GET', /^\/api\/mobile\/memory\/summary$/)).toHaveLength(1);
  });

  it('M5B1-013 client timeout falls back with disclosure and records one request', async () => {
    harness = await prepare('en', initialState(), request => request.path === '/api/mobile/memory/summary'
      ? new Promise(() => {})
      : undefined);
    await showKnows(harness);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory\/summary$/)).toHaveLength(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(15_100); });

    await waitFor(() => expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull());
    expect(screen.queryByTestId('memory-summary-disclosure')).not.toBeNull();
    expect(harness.server.matching('GET', /^\/api\/mobile\/memory\/summary$/)).toHaveLength(1);
  });

  it('M5B1-011 empty memory hides disclosure and never requests a summary', async () => {
    harness = await prepare('en', initialState({ memoryItems: [], summary: { status: 'empty' } }));
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-empty')).not.toBeNull());

    expect(harness.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/)).toHaveLength(1);
    expect(screen.queryByTestId('memory-summary-disclosure')).toBeNull();
    expect(harness.server.matching('GET', /^\/api\/mobile\/memory\/summary$/)).toHaveLength(0);
  });

  it('R1.2 capability off keeps Knows unchanged and does not expose summary UI', async () => {
    harness = await prepare('en', initialState({ memoryLearning: false }));
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-section')).not.toBeNull());

    expect(harness.server.matching('GET', /^\/api\/mobile\/capabilities\/m5b$/)).toHaveLength(1);
    expect(screen.queryByTestId('memory-summary')).toBeNull();
    expect(screen.queryByTestId('memory-summary-disclosure')).toBeNull();
    expect(screen.queryByTestId('memory-item-memory-1')).not.toBeNull();
  });
});

describe('M5b summary cache ownership', () => {
  it('M5B1-003 places the active summary query below the account memory prefix', async () => {
    harness = await prepare();
    await showKnows(harness);
    await waitFor(() => expect(screen.queryByTestId('memory-summary')).not.toBeNull());

    const summary = harness.client.getQueryCache().getAll()
      .find(query => query.queryKey.includes('summary'));
    expect(summary?.queryKey.slice(0, 3)).toEqual(queryKeys.memory(ACCOUNT_A.uid));
    expect(summary?.queryKey).toEqual([...queryKeys.memory(ACCOUNT_A.uid), 'summary', 'en']);
  });

  it.each(['routine', 'intelligence'] as const)('M5B1-003 %s writer refetches active summary and stales inactive language', async kind => {
    harness = await prepare();
    await renderWithWriter(kind);
    await waitFor(() => expect(screen.queryByTestId('memory-summary')).not.toBeNull());
    const inactiveKey = [...queryKeys.memory(ACCOUNT_A.uid), 'summary', 'ar'] as const;
    harness.client.setQueryData(inactiveKey, readySummary('ar'));
    const before = harness.server.matching('GET', /^\/api\/mobile\/memory\/summary$/).length;

    // GA-AMEND-1: a Btn's host view carries no onPress; press it as a user would.
    await fireEvent.press(screen.getByTestId('m5b-writer-probe'));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory\/summary$/).length).toBeGreaterThan(before));
    expect(harness.client.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
  });
});

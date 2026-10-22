import React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { basisCorrectionCountForTests, queryKeys, resetBasisCorrections } from '../../../api/queries';
import { ACCOUNT_A } from '../../../__acceptance__/m5b/harness';
import {
  BASIS_ID, MemoryMutationDriver, NOW, Providers, TODAY, deferred, initialState, memoryItem, outcome, panelHandler,
  planEnvelope, planWithBasis, prepare, showPanel, teardown, type M5bHarness, type RouteHandler, type RouteReply,
} from '../../../__acceptance__/m5b2a/harness';
import { PlanScreen } from '../../../screens/PlanScreen';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

/** M5b-2a Task A inspection r1 (Codex M5B2A-REV-001…003). */
let harness: M5bHarness | undefined;
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(NOW); });
afterEach(async () => { await teardown(harness); harness = undefined; jest.useRealTimers(); });

function planOnly(value: Record<string, unknown>, extra?: RouteHandler): RouteHandler {
  return (request) => {
    if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) return { status: 200, body: planEnvelope(value) };
    return extra?.(request);
  };
}

describe('M5b-2a inspection fixes', () => {
  it('REV-001: a cached on-mode plan shows no memory line or notice while M5b is off', async () => {
    harness = await prepare('en', initialState({ memoryLearning: false }), planOnly(planWithBasis(TODAY, BASIS_ID, { changed: true, rebuildsLeft: 0 })));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed-no-rebuild')).toBeNull();
    expect(screen.queryByTestId('m5b-plan-memory-changed')).toBeNull();
  });

  it('REV-002: resetting on an account change forgets a correction that never settled', async () => {
    const held = deferred<RouteReply>();
    harness = await prepare('en', initialState({ memoryItems: [memoryItem(BASIS_ID)] }), planOnly(planWithBasis(), (request) => (
      request.method === 'PATCH' && request.path === `/api/mobile/memory/${BASIS_ID}` ? held.promise : undefined
    )));
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <MemoryMutationDriver />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull());
    await act(async () => { resetBasisCorrections(harness!.client); });
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
  });

  it('REV-003: a dismissal the server confirmed removes the row even when the inbox re-read fails', async () => {
    const base = panelHandler({ observations: [outcome('confirmed-gone')] });
    let reads = 0;
    harness = await prepare('en', initialState(), (request) => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        if (reads > 1) return { status: 503, body: { success: false, error: 'unavailable' } };
      }
      return base(request);
    });
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId('m5b-learned')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('m5b-learned'));
    await fireEvent.press(screen.getByTestId('m5b-learned-wrong-confirmed-gone'));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.queryByTestId('m5b-learned-row-confirmed-gone')).toBeNull();
    expect(screen.queryByTestId('m5b-learned-status')).not.toBeNull();
  });

  it('REV-006: a succeeded correction is dropped once no cached plan answer began before it', async () => {
    let reads = 0;
    harness = await prepare('en', initialState({ memoryItems: [memoryItem(BASIS_ID)] }), (request) => {
      if (request.method === 'GET' && request.path === `/api/mobile/plans/${TODAY}`) {
        reads += 1;
        return { status: 200, body: planEnvelope(reads === 1 ? planWithBasis() : { ...planWithBasis(), memoryBasis: null }) };
      }
      if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${BASIS_ID}`) {
        return { status: 200, body: { success: true, memory: memoryItem(`${BASIS_ID}-new`) } };
      }
      return undefined;
    });
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <MemoryMutationDriver />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(50); });
    expect(harness.client.getQueryData(queryKeys.plan(ACCOUNT_A.uid, TODAY))).toBeDefined();
    expect(basisCorrectionCountForTests(harness.client, ACCOUNT_A.uid)).toBe(0);
  });

  it('R2-002: a plan does not name a memory the person cannot open (the memory module answers 404)', async () => {
    harness = await prepare('en', initialState(), planOnly(planWithBasis(), (request) => (
      request.method === 'GET' && request.path === '/api/mobile/memory'
        ? { status: 404, body: { success: false, error: 'not found', reason: 'feature_unavailable' } }
        : undefined
    )));
    await render(<Providers harness={harness}><PlanScreen date={TODAY} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('plan-why')).not.toBeNull());
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/).length).toBeGreaterThan(0));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });
});

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { focusManager } from '@tanstack/react-query';
import { resetVisitThrottleForTests } from '../../lib/deviceSettings/visitThrottle';
import {
  MEMORY_A,
  MEMORY_B,
  MemoryCorrectionDriver,
  NOW,
  SUGGESTION_ID,
  generated,
  inbox,
  initialState,
  memory,
  noRetries,
  prepare,
  showBanner,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
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
  focusManager.setFocused(undefined);
  resetVisitThrottleForTests();
});

afterEach(async () => {
  focusManager.setFocused(undefined);
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function focusSettlement(): Promise<void> {
  await act(async () => { focusManager.setFocused(false); });
  await act(async () => { focusManager.setFocused(true); });
}

async function scheduledSettlement(): Promise<void> {
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
}

describe('M5b-2b-1 IntelligencePanel freshness signals', () => {
  it('R6-002 a successful memory mutation bumps the mounted panel and rereads its inbox', async () => {
    let active = true;
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(active ? [row] : [], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') {
        return { status: 200, body: { items: active ? [memory(MEMORY_A)] : [memory(MEMORY_B)], suggestions: [], adaptive: null } };
      }
      if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${MEMORY_A}`) {
        active = false;
        return { status: 200, body: { success: true, memory: memory(MEMORY_B) } };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness, <MemoryCorrectionDriver />);
    await waitFor(() => expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).not.toBeNull());

    await fireEvent.press(screen.getByTestId('gate-correct-memory'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/memory/${MEMORY_A}$`))).toHaveLength(1));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(2));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
  });

  it('R7-003 a remote correction changing the fresh memory id set rereads and removes the card', async () => {
    let memoryReads = 0;
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/memory') {
        memoryReads += 1;
        const items = memoryReads === 1 ? [memory(MEMORY_A)] : [memory(MEMORY_B)];
        return { status: 200, body: { items, suggestions: [], adaptive: null } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(memoryReads <= 1 ? [row] : [], { basisMode: 'on_basis' }) };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).not.toBeNull());

    await focusSettlement();
    await waitFor(() => expect(memoryReads).toBeGreaterThan(1));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
  });

  it.each<[string, 404 | 500]>([
    ['404 unavailability', 404],
    ['500 error', 500],
  ])('R8-001 a memory-list %s still rereads and removes the card', async (_label, status) => {
    let memoryReads = 0;
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/memory') {
        memoryReads += 1;
        return memoryReads === 1
          ? { status: 200, body: { items: [memory(MEMORY_A)], suggestions: [], adaptive: null } }
          : { status, body: { success: false, error: status === 404 ? 'feature_unavailable' : 'unavailable', reason: status === 404 ? 'feature_unavailable' : 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(memoryReads <= 1 ? [row] : [], { basisMode: memoryReads <= 1 ? 'on_basis' : 'on_nobasis' }) };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).not.toBeNull());

    await scheduledSettlement();
    await waitFor(() => expect(memoryReads).toBeGreaterThan(1));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
  });

  it.each<[string, () => Promise<void>]>([
    ['scheduled', scheduledSettlement],
    ['focus', focusSettlement],
  ])('R10-002 an unchanged id set on %s settlement still rereads the inbox', async (_label, settle) => {
    let memoryReads = 0;
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/memory') {
        memoryReads += 1;
        return { status: 200, body: { items: [memory(MEMORY_A)], suggestions: [], adaptive: null } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(memoryReads <= 1 ? [row] : [], { basisMode: 'on_basis' }) };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(`m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`)).not.toBeNull());

    await settle();
    await waitFor(() => expect(memoryReads).toBeGreaterThan(1));
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
  });
});

describe('M5b-2b-1 Today banner freshness', () => {
  it.each<[string, 'replacement' | 'empty' | 'unavailable']>([
    ['remote correction', 'replacement'],
    ['remote deletion', 'empty'],
    ['on_nobasis memory 404', 'unavailable'],
  ])('R9-001 %s removes the memory-shaped Today banner', async (_label, outcome) => {
    let memoryReads = 0;
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return { status: 200, body: generated([row], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') {
        memoryReads += 1;
        if (memoryReads === 1) return { status: 200, body: { items: [memory(MEMORY_A)], suggestions: [], adaptive: null } };
        if (outcome === 'unavailable') {
          return { status: 404, body: { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' } };
        }
        return {
          status: 200,
          body: { items: outcome === 'replacement' ? [memory(MEMORY_B)] : [], suggestions: [], adaptive: null },
        };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([], { basisMode: outcome === 'unavailable' ? 'on_nobasis' : 'on_basis' }) };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showBanner(harness);
    await waitFor(() => expect(screen.queryByTestId('today-proactive-suggestion')).not.toBeNull());
    await waitFor(() => expect(memoryReads).toBe(1));

    await scheduledSettlement();
    await waitFor(() => expect(memoryReads).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByTestId('today-proactive-suggestion')).toBeNull());
    expect(harness.server.matching('GET', /^\/api\/mobile\/intelligence$/).length).toBeGreaterThan(0);
  });
});

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, screen, waitFor } from '@testing-library/react-native';
import { focusManager } from '@tanstack/react-query';
import { resetVisitThrottleForTests } from '../../lib/deviceSettings/visitThrottle';
import {
  MEMORY_A,
  NOW,
  SUGGESTION_ID,
  generated,
  inbox,
  initialState,
  memory,
  noRetries,
  prepare,
  schedule,
  showBanner,
  showPanel,
  suggestion,
  teardown,
  type M5bHarness,
  type RouteHandler,
  type RouteReply,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function remountPanel(handler: RouteHandler, memoryLearning = true): Promise<void> {
  if (harness) await teardown(harness);
  harness = await prepare('en', initialState({ memoryLearning, memoryItems: [memory(MEMORY_A)] }), handler);
  noRetries(harness);
  await showPanel(harness);
}

async function remountBanner(handler: RouteHandler, memoryLearning = true): Promise<void> {
  if (harness) await teardown(harness);
  resetVisitThrottleForTests();
  harness = await prepare('en', initialState({ memoryLearning, memoryItems: [memory(MEMORY_A)] }), handler);
  noRetries(harness);
  await showBanner(harness);
}

async function refocus(): Promise<void> {
  await act(async () => { focusManager.setFocused(false); });
  await act(async () => { focusManager.setFocused(true); });
}

describe('M5b-2b-1 envelope classification', () => {
  it.each<[string, string[] | undefined]>([
    ['cited', [MEMORY_A]],
    ['citationless', undefined],
  ])('R13-001 unknown capability hides an on_basis %s card and its schedule, while classified on_nobasis stays', async (_label, memoryIds) => {
    const row = suggestion(SUGGESTION_ID, memoryIds === undefined ? {} : { memoryIds });
    const unknownOnBasis: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([row], { basisMode: 'on_basis', schedule: [schedule()] }) };
      }
      return undefined;
    };
    await remountPanel(unknownOnBasis);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(1));

    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
    expect(screen.queryByTestId(`m5b-suggestion-schedule-${SUGGESTION_ID}`)).toBeNull();

    const onNoBasis: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID)], { basisMode: 'on_nobasis' }) };
      }
      return undefined;
    };
    await remountPanel(onNoBasis);
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());
  });

  it('R14-002 a cold unknown legacy envelope stays hidden because absence is not classified off', async () => {
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID)]) };
      }
      return undefined;
    };
    await remountPanel(handler);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(1));

    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
  });

  it('R12-001 a capability transition rereads without blanking the ordinary suggestion it replaces from a classified response', async () => {
    let capabilityReads = 0;
    let inboxReads = 0;
    const row = suggestion(SUGGESTION_ID);
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        capabilityReads += 1;
        return { status: 200, body: { success: true, memoryLearning: capabilityReads > 1 } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        inboxReads += 1;
        return { status: 200, body: inbox([row], inboxReads === 1 ? {} : { basisMode: 'on_nobasis' }) };
      }
      return undefined;
    };
    await remountPanel(handler, false);
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());

    await refocus();
    await waitFor(() => expect(capabilityReads).toBeGreaterThan(1));
    await waitFor(() => expect(inboxReads).toBeGreaterThan(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull();
  });

  it('R13-001 a suggestion already classified off stays visible when the capability becomes unknown', async () => {
    let capabilityReads = 0;
    let inboxReads = 0;
    const row = suggestion(SUGGESTION_ID);
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        capabilityReads += 1;
        return capabilityReads === 1
          ? { status: 200, body: { success: true, memoryLearning: false } }
          : { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        inboxReads += 1;
        return { status: 200, body: inbox([row]) };
      }
      return undefined;
    };
    await remountPanel(handler, false);
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());

    await refocus();
    await waitFor(() => expect(capabilityReads).toBeGreaterThan(1));
    await waitFor(() => expect(inboxReads).toBeGreaterThan(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull();
  });

  it('R14-002 a true capability keeps an unclassified response hidden until its transition reread is classified', async () => {
    const capability = deferred<RouteReply>();
    let inboxReads = 0;
    const row = suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') return capability.promise;
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        inboxReads += 1;
        return { status: 200, body: inbox([row], inboxReads === 1 ? {} : { basisMode: 'on_basis' }) };
      }
      return undefined;
    };
    await remountPanel(handler);
    await waitFor(() => expect(inboxReads).toBe(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();

    await act(async () => capability.resolve({ status: 200, body: { success: true, memoryLearning: true } }));
    await waitFor(() => expect(inboxReads).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());
  });

  it('R14-002 cold memory-learning off keeps ordinary suggestions in both probe/inbox orders', async () => {
    const capability = deferred<RouteReply>();
    const row = suggestion(SUGGESTION_ID);
    const inboxFirst: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') return capability.promise;
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([row]) };
      }
      return undefined;
    };
    await remountPanel(inboxFirst, false);
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/intelligence$/)).toHaveLength(1));
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
    await act(async () => capability.resolve({ status: 200, body: { success: true, memoryLearning: false } }));
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());

    const response = deferred<RouteReply>();
    const probeFirst: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        return { status: 200, body: { success: true, memoryLearning: false } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') return response.promise;
      return undefined;
    };
    await remountPanel(probeFirst, false);
    expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).toBeNull();
    await act(async () => response.resolve({ status: 200, body: inbox([row]) }));
    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${SUGGESTION_ID}`)).not.toBeNull());
  });

  it('R9-001 / R13-001 Today hides unknown on_basis generation but keeps classified on_nobasis generation', async () => {
    const onBasis: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return { status: 200, body: generated([suggestion(SUGGESTION_ID)], { basisMode: 'on_basis', schedule: [schedule()] }) };
      }
      return undefined;
    };
    await remountBanner(onBasis);
    await waitFor(() => expect(harness!.server.matching('POST', /\/intelligence\/generate$/)).toHaveLength(1));
    expect(screen.queryByTestId('today-proactive-suggestion')).toBeNull();

    const onNoBasis: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return { status: 200, body: generated([suggestion(SUGGESTION_ID)], { basisMode: 'on_nobasis' }) };
      }
      return undefined;
    };
    await remountBanner(onNoBasis);
    await waitFor(() => expect(screen.queryByTestId('today-proactive-suggestion')).not.toBeNull());
  });
});

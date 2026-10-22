/**
 * M5b-2b-1: behaviours of the suggestion basis beyond the acceptance gate
 * (`src/__acceptance__/m5b2b1`), driven through the real client as the gate is.
 *
 *   - A suggestion read that began before a memory correction succeeded never
 *     shows that memory's line again, even once the correction is pruned.
 *   - A reread asked for by a signal that fails clears the held suggestions
 *     (R9-001), in the panel and on Today.
 *   - With M5b known off, a memory write reads nothing again (off unchanged).
 *   - Suggestions a classification hides do not leave a «no ideas» line
 *     claiming there are none.
 *   - A memory list that fails at mount does not hold a cited card back.
 *   - Codex inspection: a visit whose answer changes a held suggestion's
 *     basis (same id) reads again (APP-001); an unavailable suggestion leaves
 *     at once, and a failed read after it does not bring it back (APP-002); a
 *     failed signal reread claims no «no ideas» (APP-003); an empty holder
 *     polls nothing (APP-004).
 *   - Codex second inspection: only a cited card waits for the memory list,
 *     not a citationless one beside it (APP-UI-004); a visit whose follow-up
 *     read fails clears what it proved stale and keeps the visit's throttle
 *     (APP-VISIT-006).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { IntelligencePanel } from '../../goals/IntelligencePanel';
import { claimVisit, resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';
import en from '../../../i18n/locales/en.json';
import {
  MEMORY_A,
  MemoryCorrectionDriver,
  NOW,
  Providers,
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
} from '../../../__acceptance__/m5b2b1/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M5bHarness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  resetVisitThrottleForTests();
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

const INBOX = /^\/api\/mobile\/intelligence$/;
const CARD = `intelligence-suggestion-${SUGGESTION_ID}`;
const LINE = `m5b-suggestion-basis-${SUGGESTION_ID}-${MEMORY_A}`;
const memoryList = (ids: string[]): RouteReply => ({ status: 200, body: { items: ids.map(id => memory(id)), suggestions: [], adaptive: null } });

async function scheduledSettlement(): Promise<void> {
  await act(async () => { await jest.advanceTimersByTimeAsync(60_000); });
}

describe('M5b-2b-1 suggestion basis, beyond the gate', () => {
  it('R3 keeps a line hidden for a read that began before its memory\'s correction succeeded', async () => {
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        // The read the correction asks for never answers here: what is on
        // screen stays the read from before the correction.
        if (reads > 1) return new Promise<RouteReply>(() => undefined);
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] })], { basisMode: 'on_basis' }) };
      }
      // The list still names the memory (another device has not caught up).
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${MEMORY_A}`) {
        return { status: 200, body: { success: true, memory: memory(MEMORY_A) } };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness, <MemoryCorrectionDriver />);
    await waitFor(() => expect(screen.queryByTestId(LINE)).not.toBeNull());

    await fireEvent.press(screen.getByTestId('gate-correct-memory'));
    await waitFor(() => expect(reads).toBe(2));
    // Past the correction's pruning and the list's refetch.
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(screen.queryByTestId(CARD)).not.toBeNull();
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it('R9-001 a failed signal reread clears the panel\'s held suggestions', async () => {
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        return reads === 1
          ? { status: 200, body: inbox([suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] })], { basisMode: 'on_basis' }) }
          : { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(CARD)).not.toBeNull());

    await scheduledSettlement();
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByTestId(CARD)).toBeNull());
    // APP-003: unknown is not «nothing to suggest».
    expect(screen.queryByText(en.xIntelligenceNoIdeas)).toBeNull();
  });

  it('R9-001 a failed signal reread clears Today\'s banner', async () => {
    const handler: RouteHandler = request => {
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return { status: 200, body: generated([suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] })], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showBanner(harness);
    await waitFor(() => expect(screen.queryByTestId('today-proactive-suggestion')).not.toBeNull());
    await waitFor(() => expect(harness!.server.matching('GET', /^\/api\/mobile\/memory$/)).toHaveLength(1));

    await scheduledSettlement();
    await waitFor(() => expect(harness!.server.matching('GET', INBOX).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByTestId('today-proactive-suggestion')).toBeNull());
  });

  it('R14-002 parity: with M5b known off, a memory write reads the inbox nothing more', async () => {
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID)]) };
      }
      if (request.method === 'PATCH' && request.path === `/api/mobile/memory/${MEMORY_A}`) {
        return { status: 200, body: { success: true, memory: memory(MEMORY_A) } };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryLearning: false, memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness, <MemoryCorrectionDriver />);
    await waitFor(() => expect(screen.queryByTestId(CARD)).not.toBeNull());

    await fireEvent.press(screen.getByTestId('gate-correct-memory'));
    await waitFor(() => expect(harness!.server.matching('PATCH', /\/memory\//)).toHaveLength(1));
    await act(async () => { await jest.advanceTimersByTimeAsync(100); });
    expect(harness.server.matching('GET', INBOX)).toHaveLength(1);
    expect(screen.queryByTestId(CARD)).not.toBeNull();
  });

  it('R13-001 hidden suggestions leave no «no ideas» line behind', async () => {
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/capabilities/m5b') return { status: 500, body: { success: false, error: 'unavailable' } };
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID)], { basisMode: 'on_basis' }) };
      }
      return undefined;
    };
    harness = await prepare('en', initialState(), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId('intelligence-statement')).not.toBeNull());

    expect(screen.queryByTestId(CARD)).toBeNull();
    expect(screen.queryByText(en.xIntelligenceNoIdeas)).toBeNull();
  });

  it('R3 a memory list that fails at mount shows the cited card without its line', async () => {
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] })], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') {
        return { status: 500, body: { success: false, error: 'unavailable' } };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);

    await waitFor(() => expect(screen.queryByTestId(CARD)).not.toBeNull());
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it('APP-001 a visit whose answer changes a held suggestion\'s basis under the same id reads the inbox again', async () => {
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        return { status: 200, body: inbox([suggestion(SUGGESTION_ID, reads === 1 ? { memoryIds: [MEMORY_A] } : {})], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return { status: 200, body: generated([suggestion(SUGGESTION_ID)], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await render(<Providers harness={harness}><IntelligencePanel onChanged={() => undefined} autoGenerate /></Providers>);
    await waitFor(() => expect(harness!.server.matching('POST', /\/intelligence\/generate$/)).toHaveLength(1));
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.queryByTestId(CARD)).not.toBeNull());
    expect(screen.queryByTestId(LINE)).toBeNull();
  });

  it('APP-002 an unavailable suggestion leaves at once, and a failed read after it does not bring it back', async () => {
    let reads = 0;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        if (reads === 1) return { status: 200, body: inbox([suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] })], { basisMode: 'on_basis' }) };
        return held.then(() => ({ status: 500, body: { success: false, error: 'unavailable' } }));
      }
      if (request.method === 'POST' && request.path === `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}`) {
        return { status: 404, body: { success: false, error: 'not_found', reason: 'suggestion_unavailable' } };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByTestId(CARD)).not.toBeNull());

    await fireEvent.press(within(screen.getByTestId(CARD)).getAllByRole('button')[0]!);
    await waitFor(() => expect(reads).toBe(2));
    // Gone while the read after it is still on its way.
    expect(screen.queryByTestId(CARD)).toBeNull();
    await act(async () => { release(); await jest.advanceTimersByTimeAsync(10); });
    expect(screen.queryByTestId(CARD)).toBeNull();
    expect(screen.queryByTestId('m5b-suggestion-action-error')).toBeNull();
    expect(screen.queryByText(en.xIntelligenceNoIdeas)).toBeNull();
  });

  it('APP-004 an empty panel polls neither the memory list nor the inbox', async () => {
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox([], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);
    await waitFor(() => expect(screen.queryByText(en.xIntelligenceNoIdeas)).not.toBeNull());

    for (let minute = 0; minute < 3; minute += 1) await scheduledSettlement();
    expect(harness.server.matching('GET', /^\/api\/mobile\/memory$/)).toHaveLength(0);
    expect(harness.server.matching('GET', INBOX)).toHaveLength(1);
  });

  it('APP-004 an empty Today banner polls neither the memory list nor the inbox', async () => {
    const handler: RouteHandler = request => {
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return { status: 200, body: generated([], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showBanner(harness);
    await waitFor(() => expect(harness!.server.matching('POST', /\/intelligence\/generate$/)).toHaveLength(1));

    for (let minute = 0; minute < 3; minute += 1) await scheduledSettlement();
    expect(harness.server.matching('GET', /^\/api\/mobile\/memory$/)).toHaveLength(0);
    expect(harness.server.matching('GET', INBOX)).toHaveLength(0);
  });

  it('APP-UI-004 a slow memory list holds back only the cited card, not the citationless one and its schedule', async () => {
    const OTHER = 'plain-suggestion';
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(
          [suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] }), suggestion(OTHER)],
          { basisMode: 'on_basis', schedule: [schedule(SUGGESTION_ID), schedule(OTHER)] },
        ) };
      }
      // The memory list never answers here.
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return new Promise<RouteReply>(() => undefined);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await showPanel(harness);

    await waitFor(() => expect(screen.queryByTestId(`intelligence-suggestion-${OTHER}`)).not.toBeNull());
    expect(screen.queryByTestId(`m5b-suggestion-schedule-${OTHER}`)).not.toBeNull();
    expect(screen.queryByTestId(CARD)).toBeNull();
    expect(screen.queryByTestId(`m5b-suggestion-schedule-${SUGGESTION_ID}`)).toBeNull();
    expect(screen.queryByText(en.xIntelligenceNoIdeas)).toBeNull();
  });

  it('APP-VISIT-006 a differing visit whose follow-up read fails clears what is held and keeps the visit\'s throttle', async () => {
    let reads = 0;
    let answerVisit!: () => void;
    const visit = new Promise<void>(resolve => { answerVisit = resolve; });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        reads += 1;
        return reads === 1
          ? { status: 200, body: inbox([suggestion(SUGGESTION_ID, { memoryIds: [MEMORY_A] })], { basisMode: 'on_basis' }) }
          : { status: 500, body: { success: false, error: 'unavailable' } };
      }
      if (request.method === 'POST' && request.path === '/api/mobile/intelligence/generate') {
        return visit.then(() => ({ status: 200, body: generated([suggestion(SUGGESTION_ID)], { basisMode: 'on_basis' }) }));
      }
      if (request.method === 'GET' && request.path === '/api/mobile/memory') return memoryList([MEMORY_A]);
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await render(<Providers harness={harness}><IntelligencePanel onChanged={() => undefined} autoGenerate /></Providers>);
    await waitFor(() => expect(screen.queryByTestId(LINE)).not.toBeNull());

    await act(async () => { answerVisit(); });
    await waitFor(() => expect(reads).toBe(2));
    await waitFor(() => expect(screen.queryByTestId(CARD)).toBeNull());
    expect(screen.queryByText(en.xIntelligenceNoIdeas)).toBeNull();
    // The visit answered, so the next one waits the visit's interval, not
    // the half hour a failed visit waits.
    expect(await claimVisit('m5b-account-a', NOW.getTime() + 31 * 60_000)).toBe(false);
  });
});

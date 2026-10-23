/**
 * M5b-2b-1 (APP-READ-006), on a production host: «يتابع لك» with the real
 * suggestion basis hooks and the real `useIntelligenceDecided`, the network
 * answered per route under the real client.
 *
 *   - One action costs one inbox read after it. The host's memory revision
 *     bump is the acting panel's own; it does not set off a second read.
 *   - A dismissal and a warning acknowledged write no memory: no revision
 *     bump, so no other holder reads again for them.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { WatchingScreen } from '../../watching/WatchingScreen';
import { memoryRevisionOf } from '../../../api/queries';
import { resetVisitThrottleForTests } from '../../../lib/deviceSettings/visitThrottle';
import {
  MEMORY_A,
  NOW,
  Providers,
  SUGGESTION_ID,
  inbox,
  initialState,
  memory,
  noRetries,
  prepare,
  suggestion,
  teardown,
  type M5bHarness,
  type RouteHandler,
} from '../../../__acceptance__/m5b2b1/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

const UID = 'm5b-account-a';
const INBOX = /^\/api\/mobile\/intelligence$/;
const CARD = `intelligence-suggestion-${SUGGESTION_ID}`;

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

type Case = { label: string; kind: 'action' | 'warning'; decision: 'accept' | 'dismiss'; button: 0 | 1; bumps: boolean };

const CASES: Case[] = [
  { label: 'an accepted suggestion', kind: 'action', decision: 'accept', button: 0, bumps: true },
  { label: 'a dismissed suggestion', kind: 'action', decision: 'dismiss', button: 1, bumps: false },
  { label: 'an acknowledged warning', kind: 'warning', decision: 'accept', button: 0, bumps: false },
];

describe('APP-READ-006 one action, one inbox read, on «يتابع لك»', () => {
  it.each(CASES)('APP-READ-006 $label reads the inbox once after it, and bumps the memory revision only if it may write memory', async ({ kind, decision, button, bumps }) => {
    let decided = false;
    const row = suggestion(SUGGESTION_ID, { kind, memoryIds: [MEMORY_A] });
    const handler: RouteHandler = request => {
      if (request.method === 'GET' && request.path === '/api/mobile/intelligence') {
        return { status: 200, body: inbox(decided ? [] : [row], { basisMode: 'on_basis' }) };
      }
      if (request.method === 'POST' && request.path === `/api/mobile/intelligence/suggestions/${SUGGESTION_ID}`) {
        decided = true;
        return { status: 200, body: { success: true, suggestion: { ...row, status: decision === 'accept' ? 'accepted' : 'dismissed' } } };
      }
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memory(MEMORY_A)] }), handler);
    noRetries(harness);
    await render(<Providers harness={harness}><WatchingScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId(CARD)).not.toBeNull());
    const readsBefore = harness.server.matching('GET', INBOX).length;
    const revisionBefore = memoryRevisionOf(UID);

    await fireEvent.press(within(screen.getByTestId(CARD)).getAllByRole('button')[button]!);
    await waitFor(() => expect(screen.queryByTestId(CARD)).toBeNull());
    // Past every reread a signal could still ask for (the list's refetch too).
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });

    expect(harness.server.matching('POST', /\/intelligence\/suggestions\//)).toHaveLength(1);
    expect(harness.server.matching('GET', INBOX).length - readsBefore).toBe(1);
    expect(memoryRevisionOf(UID) - revisionBefore).toBe(bumps ? 1 : 0);
  });
});

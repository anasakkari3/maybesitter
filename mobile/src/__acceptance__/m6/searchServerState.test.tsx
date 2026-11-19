/**
 * What the search says while the server has not answered, or failed (CA5.2),
 * and the commitments screen's browse controls during a search (CA5.7).
 *
 * CA5.2: a needle whose only match is server-side (done, dropped, older) read
 * the no-results line before the answer came and kept saying it when the
 * server refused (400 for a long needle) — although the item exists.
 *
 * CA5.7: while searching, the sort and the open/done filter changed their own
 * label or checked state but not the list. A search looks everywhere, so they
 * are not offered during one (like the add button).
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CommitmentsScreen } from '../../features/product/ContextScreens';
import { ThingsScreen } from '../../features/things/ThingsScreen';
import { NOW, Providers, commitment, prepareM6, searchRequests, teardown, type M6Harness } from './harness';
import type { RouteReply } from '../m5b/harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M6Harness | undefined;
let release: (() => void) | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  release?.();
  release = null;
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

const refusing = (status: number) => async (request: { path: string; method: string }): Promise<RouteReply | undefined> =>
  request.path === '/api/mobile/commitments/search' && request.method === 'POST'
    ? { status, body: { success: false, error: 'invalid_query' } }
    : undefined;

const holding = async (request: { path: string; method: string }): Promise<RouteReply | undefined> => {
  if (request.path !== '/api/mobile/commitments/search' || request.method !== 'POST') return undefined;
  await new Promise<void>(resolve => { release = resolve; });
  return { status: 200, body: { success: true, items: [], truncated: false } };
};

async function type(testID: string, query: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId(testID), query);
  await act(async () => { jest.advanceTimersByTime(300); });
}

describe('server search state on My things (CA5.2)', () => {
  it('says it is still looking while the server has not answered', async () => {
    harness = await prepareM6('en', { commitments: [commitment('local', { title: 'Unrelated' })], handler: holding });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await type('things-search', 'Report');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));
    expect(screen.queryByTestId('m6-search-pending')).not.toBeNull();
    expect(screen.queryByTestId('m6-search-no-results')).toBeNull();
  });

  it('says the search failed, with a retry, instead of nothing found', async () => {
    harness = await prepareM6('en', { commitments: [commitment('local', { title: 'Unrelated' })], handler: refusing(400) });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await type('things-search', 'Report');
    await waitFor(() => expect(screen.queryByTestId('m6-search-failed')).not.toBeNull());
    expect(screen.queryByTestId('m6-search-no-results')).toBeNull();
    expect(screen.queryByTestId('m6-search-retry')).not.toBeNull();
  });
});

describe('the commitments screen during a search', () => {
  it('says the search failed instead of no matching commitments (CA5.2)', async () => {
    harness = await prepareM6('en', { commitments: [commitment('local', { title: 'Unrelated' })], handler: refusing(400) });
    await render(<Providers harness={harness}><CommitmentsScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('commitments-search')).not.toBeNull());
    await type('commitments-search', 'Report');
    await waitFor(() => expect(screen.queryByTestId('m6-search-failed')).not.toBeNull());
    expect(screen.queryByTestId('commitments-no-results')).toBeNull();
  });

  it('does not offer the sort or the open/done filter while searching (CA5.7)', async () => {
    harness = await prepareM6('en', { commitments: [commitment('local', { title: 'Report draft' })] });
    await render(<Providers harness={harness}><CommitmentsScreen /></Providers>);
    await waitFor(() => expect(screen.queryByTestId('commitments-sort')).not.toBeNull());
    expect(screen.queryByTestId('commitments-filter-done')).not.toBeNull();
    await type('commitments-search', 'Report');
    expect(screen.queryByTestId('commitments-sort')).toBeNull();
    expect(screen.queryByTestId('commitments-filter-done')).toBeNull();
    expect(screen.queryByTestId('commitments-filter-all')).toBeNull();
  });
});

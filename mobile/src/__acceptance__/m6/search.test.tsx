import React from 'react';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { CommitmentsScreen } from '../../features/product/ContextScreens';
import { ThingsScreen } from '../../features/things/ThingsScreen';
import {
  ACCOUNT_A,
  NOW,
  ZONE,
  Providers,
  commitment,
  fact,
  prepareM6,
  searchRequests,
  teardown,
  type M6Harness,
  type RecordedRequest,
} from './harness';

jest.mock('expo-localization', () => ({
  getCalendars: jest.fn(() => [{ timeZone: 'Asia/Jerusalem' }]),
  getLocales: jest.fn(() => [{ languageCode: 'en', languageTag: 'en-US', textDirection: 'ltr' }]),
}));

let harness: M6Harness | undefined;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
});

afterEach(async () => {
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

async function settleDebounce(ms = 300): Promise<void> {
  await act(async () => { jest.advanceTimersByTime(ms); });
}

async function searchThings(query: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('things-search'), query);
  await settleDebounce();
}

async function searchCommitments(query: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('commitments-search'), query);
  await settleDebounce();
}

function habit(id: string, title: string) {
  return {
    habitId: id, title, cadence: { kind: 'weekly_count', count: 2 }, durationMinutes: 30,
    preferredWindows: [], minimumOccurrences: 1, maximumOccurrences: 2,
    flexibility: 'flexible', recoveryPolicy: 'skip', status: 'active', source: 'user_created',
    confirmation: { confirmedByUserAt: NOW.toISOString(), sourceRef: null, acceptedSuggestedValues: false },
    createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
}

function seed(id: string, summary: string) {
  return {
    version: 'v1', seedId: id, scopeId: ACCOUNT_A.uid, kind: 'idea', summary, status: 'open', revisitAt: null,
    source: 'manual', sourceRef: null,
    provenance: { proposalId: null, extractor: null, confirmedByUserAt: NOW.toISOString() },
    promotedTo: null, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };
}

describe('M6 mixed search', () => {
  it('R54.2 sections expose shown per-type counts and rank word prefixes before substrings', async () => {
    // GA-M6-AMEND-4: «alpha» inside a word, not at a word start («Call alpha team» is a word-start match by the plan and Gate B's fixtures).
    const substring = commitment('substring', { title: 'Call metalpha team' });
    const prefix = commitment('prefix', { title: 'Alpha planning' });
    harness = await prepareM6('en', {
      commitments: [substring, prefix],
      memoryItems: [{ ...fact('goal-alpha', 'Alpha goal'), kind: 'goal' }],
      habits: [habit('habit-alpha', 'Alpha habit')],
      seeds: [seed('seed-alpha', 'Alpha idea')],
      searchHistory: false,
    });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await searchThings('alpha');
    await waitFor(() => expect(screen.queryByTestId('m6-search-section-commitments')).not.toBeNull());

    for (const type of ['commitments', 'goals', 'habits', 'ideas']) {
      expect(screen.queryByTestId(`m6-search-section-${type}`)).not.toBeNull();
      expect(screen.queryByTestId(`m6-search-count-${type}`)).not.toBeNull();
    }
    const rows = screen.getAllByTestId(/^m6-search-result-commitment-/);
    expect(rows.map(row => row.props.testID)).toEqual([
      'm6-search-result-commitment-prefix',
      'm6-search-result-commitment-substring',
    ]);
  });

  it('R2-011 waits 300 ms and requires two searchable folded characters', async () => {
    harness = await prepareM6('en', { searchHistory: true, searchItems: [commitment('server-match')] });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);

    // Arabic tatweel plus one letter folds to one searchable character.
    await fireEvent.changeText(screen.getByTestId('things-search'), '\u0640\u0640\u0627');
    await settleDebounce(600);
    expect(searchRequests(harness)).toHaveLength(0);
    // Hebrew niqqud alone folds to no searchable characters.
    await fireEvent.changeText(screen.getByTestId('things-search'), '\u05b9\u05c2');
    await settleDebounce(600);
    expect(searchRequests(harness)).toHaveLength(0);

    // Hebrew: two letters. Nothing is sent at 299 ms; one request leaves at 300 ms.
    await fireEvent.changeText(screen.getByTestId('things-search'), '\u05d0\u05d1');
    await settleDebounce(299);
    expect(searchRequests(harness)).toHaveLength(0);
    await settleDebounce(1);
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));
  });

  it('M6A-R5-001 sends POST q in JSON, keeps the URL empty, merges by id, and marks settled rows', async () => {
    const duplicate = commitment('duplicate', { title: 'Alpha duplicate' });
    const done = commitment('done', { title: 'Alpha done', status: 'completed' /* GA-M6-AMEND-2: the DTO's own vocabulary */, completedAt: '2030-03-20T10:00:00.000Z' });
    const dropped = commitment('dropped', { title: 'Alpha dropped', status: 'dropped', droppedAt: '2030-03-21T10:00:00.000Z' });
    harness = await prepareM6('en', {
      commitments: [duplicate], searchItems: [duplicate, done, dropped], searchHistory: true,
    });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await searchThings('Alpha');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));

    const request = searchRequests(harness)[0]!;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/api/mobile/commitments/search');
    expect(request.query.toString()).toBe('');
    expect(request.body).toMatchObject({ q: 'Alpha' });
    expect(screen.getAllByTestId('m6-search-result-commitment-duplicate')).toHaveLength(1);

    // GA-M6-AMEND-5: the answer renders after the request is recorded; wait for it.
    await waitFor(() => expect(screen.queryByTestId('m6-search-status-done')).not.toBeNull());
    expect(screen.queryByTestId('m6-search-status-dropped')).not.toBeNull();
  });

  it('M6A-010 / R2-012 accepts historical, future-postponed and 90-day settled rows from the wire', async () => {
    const historical = commitment('historical-live', {
      title: 'Needle historical live',
      createdAt: '2029-01-01T09:00:00.000Z',
      timeSpec: { kind: 'unscheduled', dueAt: null, endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    });
    const overdue = commitment('historical-overdue', {
      title: 'Needle historical overdue',
      createdAt: '2029-01-01T09:00:00.000Z',
      timeSpec: { kind: 'due_by', dueAt: '2029-06-01T09:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: ZONE },
    });
    const postponed = commitment('future-postponed', {
      title: 'Needle future postponed',
      postponedUntil: '2030-04-20T09:00:00.000Z',
    });
    const settledAtEdge = [
      commitment('done-edge', {
        title: 'Needle done edge', status: 'completed' /* GA-M6-AMEND-2: the DTO's own vocabulary */, completedAt: '2029-12-30T09:00:00.000Z',
      }),
      commitment('dropped-edge', {
        title: 'Needle dropped edge', status: 'dropped', droppedAt: '2029-12-30T09:00:00.000Z',
      }),
    ];
    const emitted = [historical, overdue, postponed, ...settledAtEdge];
    harness = await prepareM6('en', { commitments: [], searchItems: emitted });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await searchThings('Needle');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('m6-search-status-dropped-edge')).not.toBeNull()); // GA-M6-AMEND-5

    expect(screen.getAllByTestId(/^m6-search-result-commitment-/).map(row => row.props.testID)).toEqual(
      emitted.map(item => `m6-search-result-commitment-${item.id}`),
    );
    expect(screen.queryByTestId('m6-search-status-done-edge')).not.toBeNull();
    expect(screen.queryByTestId('m6-search-status-dropped-edge')).not.toBeNull();
  });

  it('M6A-R4-004 uses the exact uid-scoped folded key and cancels an obsolete request', async () => {
    let searches = 0;
    harness = await prepareM6('en', {
      handler: (request: RecordedRequest) => {
        if (request.path !== '/api/mobile/commitments/search') return undefined;
        searches += 1;
        if (searches === 1) return new Promise(() => undefined);
        return { status: 200, body: { success: true, items: [], truncated: false } };
      },
    });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await searchThings('ÁLPHA');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));

    const fetchMock = jest.mocked(globalThis.fetch);
    const firstSearchCall = fetchMock.mock.calls.find(([input]) => String(input).includes('/commitments/search'));
    const firstSignal = (firstSearchCall?.[1] as RequestInit | undefined)?.signal;
    expect(firstSignal?.aborted).toBe(false);

    await searchThings('beta');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(2));
    expect(firstSignal?.aborted).toBe(true);
    expect(harness.client.getQueryCache().find({
      queryKey: ['user', ACCOUNT_A.uid, 'commitments', 'search', 'beta', 30], exact: true,
    })).toBeDefined();
  });

  it('M6A-R4-004 refetches after commitment-prefix invalidation for edit, complete, drop and delete', async () => {
    const row = commitment('changing', { title: 'Alpha changing' });
    harness = await prepareM6('en', { commitments: [], searchItems: [row] });
    await render(<Providers harness={harness}><CommitmentsScreen /></Providers>);
    await searchCommitments('Alpha');
    await waitFor(() => expect(screen.queryByTestId('commitments-item-changing')).not.toBeNull());

    const refresh = async (items: ReturnType<typeof commitment>[]) => {
      const before = searchRequests(harness!).length;
      harness!.setSearchItems(items);
      await harness!.client.invalidateQueries({ queryKey: ['user', ACCOUNT_A.uid, 'commitments'] });
      await waitFor(() => expect(searchRequests(harness!).length).toBeGreaterThan(before));
    };
    await refresh([commitment('changing', { title: 'Alpha edited' })]);
    expect(screen.queryByTestId('commitments-item-changing')).not.toBeNull();
    await refresh([commitment('changing', { title: 'Alpha edited', status: 'completed' /* GA-M6-AMEND-2: the DTO's own vocabulary */, completedAt: NOW.toISOString() })]);
    await waitFor(() => expect(screen.queryByTestId('m6-search-status-changing')).not.toBeNull()); // GA-M6-AMEND-5
    await refresh([commitment('changing', { title: 'Alpha edited', status: 'dropped', droppedAt: NOW.toISOString() })]);
    await waitFor(() => expect(screen.queryByTestId('m6-search-status-changing')).not.toBeNull()); // GA-M6-AMEND-5
    await refresh([]);
    await waitFor(() => expect(screen.queryByTestId('commitments-item-changing')).toBeNull());
  });

  it('M6A-R4-006 shows truncation and counts only rows actually shown', async () => {
    const items = Array.from({ length: 30 }, (_, index) => commitment(`history-${index}`, { title: `Alpha history ${index}` }));
    harness = await prepareM6('en', { commitments: [], searchItems: items, truncated: true });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await searchThings('Alpha');
    await waitFor(() => expect(screen.queryByTestId('m6-search-more')).not.toBeNull());

    expect(screen.queryByTestId('m6-search-more')).not.toBeNull();
    expect(screen.getByTestId('m6-search-count-commitments')).toHaveTextContent(/30/);
    expect(screen.queryByTestId('m6-search-result-commitment-below-cutoff')).toBeNull();
  });

  it('R54.2 mixed empty results use their own testID', async () => {
    harness = await prepareM6('he', { commitments: [], searchItems: [] });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);
    await searchThings('nothing-here');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));

    expect(screen.queryByTestId('m6-search-no-results')).not.toBeNull();
    expect(screen.queryByTestId('things-no-results')).toBeNull();
  });

  it('M6A-011 bypasses the active browser filter and dropped-row removal while a needle exists', async () => {
    const done = commitment('done-only', { title: 'Needle done', status: 'completed' /* GA-M6-AMEND-2: the DTO's own vocabulary */, completedAt: NOW.toISOString() });
    const dropped = commitment('dropped-only', { title: 'Needle dropped', status: 'dropped', droppedAt: NOW.toISOString() });
    harness = await prepareM6('en', { commitments: [], searchItems: [done, dropped] });
    await render(<Providers harness={harness}><CommitmentsScreen /></Providers>);
    await searchCommitments('Needle');
    await waitFor(() => expect(searchRequests(harness!)).toHaveLength(1));

    await waitFor(() => expect(screen.queryByTestId('commitments-item-done-only')).not.toBeNull()); // GA-M6-AMEND-5
    expect(screen.queryByTestId('commitments-item-dropped-only')).not.toBeNull();
    expect(screen.queryByTestId('m6-search-status-done-only')).not.toBeNull();
    expect(screen.queryByTestId('m6-search-status-dropped-only')).not.toBeNull();
  });

  it('R54.2 parity capability off uses local folding and sends no history request', async () => {
    const foldedName = commitment('folded-name', {
      // Arabic: Ahmad 3, written with hamza and Arabic-Indic digit.
      title: '\u0623\u062d\u0645\u062f \u0663',
    });
    harness = await prepareM6('ar', { commitments: [foldedName], searchHistory: false });
    await render(<Providers harness={harness}><ThingsScreen /></Providers>);

    // Arabic: Ahmad, without hamza.
    await searchThings('\u0627\u062d\u0645\u062f');
    await waitFor(() => expect(screen.queryByTestId('m6-search-result-commitment-folded-name')).not.toBeNull());
    await fireEvent.changeText(screen.getByTestId('things-search'), '3');
    await settleDebounce(600);
    expect(screen.queryByTestId('m6-search-result-commitment-folded-name')).not.toBeNull();
    expect(searchRequests(harness)).toHaveLength(0);
  });
});


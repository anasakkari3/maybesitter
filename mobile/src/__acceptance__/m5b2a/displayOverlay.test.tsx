import React from 'react';
import { View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { onlineManager } from '@tanstack/react-query';
import { MemoryScreen } from '../../features/memory/MemoryScreen';
import { PlanScreen } from '../../screens/PlanScreen';
import { queryKeys } from '../../api/queries';
import {
  ACCOUNT_A,
} from '../m5b/harness';
import {
  BASIS_ID,
  FUTURE,
  MemoryMutationDriver,
  NOW,
  Providers,
  TODAY,
  WeekAcceptDriver,
  deferred,
  initialState,
  memoryItem,
  mutationReply,
  planEnvelope,
  planWithBasis,
  prepare,
  showBasisPlan,
  teardown,
  weekEnvelope,
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
  onlineManager.setOnline(true);
});

afterEach(async () => {
  onlineManager.setOnline(true);
  await teardown(harness);
  harness = undefined;
  jest.useRealTimers();
});

function noRetries(value: M5bHarness): void {
  value.client.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
}

function planGet(request: { method: string; path: string }): RouteReply | undefined {
  const match = /^\/api\/mobile\/plans\/(\d{4}-\d{2}-\d{2})$/.exec(request.path);
  return request.method === 'GET' && match
    ? { status: 200, body: planEnvelope(planWithBasis(match[1]!)) }
    : undefined;
}

async function loaded(handler: RouteHandler, driver: React.ReactNode = <MemoryMutationDriver />) {
  harness = await prepare('en', initialState({ memoryItems: [memoryItem(BASIS_ID), memoryItem('other-memory')] }), handler);
  noRetries(harness);
  await showBasisPlan(harness, TODAY, driver);
  await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
}

describe('M5b-2a R2 numbered-response display overlay', () => {
  it('M5B2A-020 hides the basis while a focus edit is in flight and keeps it hidden after a failed refetch', async () => {
    const patch = deferred<RouteReply>();
    let planReads = 0;
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
        planReads += 1;
        return planReads === 1 ? planGet(request) : { status: 500, body: { success: false, error: 'offline' } };
      }
      if (request.path === `/api/mobile/memory/${BASIS_ID}` && request.method === 'PATCH') return patch.promise;
      return undefined;
    };
    await loaded(handler);

    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(1));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();

    await act(async () => patch.resolve({ status: 200, body: { success: true, memory: memoryItem(`${BASIS_ID}-new`) } }));
    await waitFor(() => expect(planReads).toBeGreaterThan(1));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  it('M5B2A-021 restores the untouched valid basis after a failed focus edit without refetching the plan', async () => {
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') { reads += 1; return planGet(request); }
      if (request.path === `/api/mobile/memory/${BASIS_ID}` && request.method === 'PATCH') {
        // GA-M5B2A-AMEND-8 (Claude): a refusal is an answer that says nothing
        // ran (400); a 500 may have committed first, and keeps the basis
        // hidden until a plan begun after it says otherwise (M5B2A-R6-001).
        return { status: 400, body: { success: false, error: 'invalid' } };
      }
      return undefined;
    };
    await loaded(handler);
    const before = reads;

    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    expect(reads).toBe(before);
  });

  it.each(['patch', 'delete'] as const)('M5B2A-022 unrelated %s leaves the basis visible through settlement', async operation => {
    const write = deferred<RouteReply>();
    const handler: RouteHandler = request => {
      if (planGet(request)) return planGet(request);
      if (request.path === '/api/mobile/memory/other-memory' && request.method === (operation === 'patch' ? 'PATCH' : 'DELETE')) return write.promise;
      return undefined;
    };
    await loaded(handler, <MemoryMutationDriver id="other-memory" />);

    await fireEvent.press(screen.getByTestId(operation === 'patch' ? 'gate-patch' : 'gate-delete'));
    await waitFor(() => expect(harness!.server.matching(operation === 'patch' ? 'PATCH' : 'DELETE', /\/memory\/other-memory$/)).toHaveLength(1));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull();
    await act(async () => write.resolve(operation === 'patch'
      ? { status: 200, body: { success: true, memory: memoryItem('other-replacement') } }
      : { status: 200, body: { success: true, deleted: 1 } }));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull();
  });

  it('M5B2A-023 delete-all hides the shared basis on every cached date even when one refetch fails', async () => {
    const reads = new Map<string, number>();
    const handler: RouteHandler = request => {
      const match = /^\/api\/mobile\/plans\/(\d{4}-\d{2}-\d{2})$/.exec(request.path);
      if (request.method === 'GET' && match) {
        const date = match[1]!;
        const count = (reads.get(date) ?? 0) + 1;
        reads.set(date, count);
        if (count > 1 && date === FUTURE) return { status: 500, body: { success: false, error: 'offline' } };
        if (count > 1) {
          const refreshed: Record<string, unknown> = { ...planWithBasis(date), memoryBasis: null };
          return { status: 200, body: planEnvelope(refreshed) };
        }
        return planGet(request);
      }
      return mutationReply(request);
    };
    harness = await prepare('en', initialState(), handler);
    noRetries(harness);
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <PlanScreen date={FUTURE} onBack={() => undefined} />
      <MemoryMutationDriver />
    </View></Providers>);
    await waitFor(() => expect(screen.queryAllByTestId('m5b-plan-memory-basis')).toHaveLength(2));

    await fireEvent.press(screen.getByTestId('gate-delete-all'));
    await waitFor(() => expect(harness!.server.matching('DELETE', /^\/api\/mobile\/memory$/)).toHaveLength(1));
    await waitFor(() => expect((reads.get(FUTURE) ?? 0)).toBeGreaterThan(1));
    expect(screen.queryAllByTestId('m5b-plan-memory-basis')).toHaveLength(0);
  });

  it('M5B2A-024 a plan GET begun before edit success cannot restore the old basis when it lands late', async () => {
    const lateGet = deferred<RouteReply>();
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
        reads += 1;
        return reads === 1 ? planGet(request) : lateGet.promise;
      }
      return mutationReply(request);
    };
    await loaded(handler);

    void harness!.client.refetchQueries({ queryKey: queryKeys.plan(ACCOUNT_A.uid, TODAY) });
    await waitFor(() => expect(reads).toBe(2));
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(1));
    await act(async () => lateGet.resolve({ status: 200, body: planEnvelope(planWithBasis()) }));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull());
  });

  it('M5B2A-025 a plan action begun before delete success cannot adopt the old basis afterwards', async () => {
    const action = deferred<RouteReply>();
    const handler: RouteHandler = request => {
      if (planGet(request)) return planGet(request);
      if (request.path === `/api/mobile/plans/${TODAY}/actions` && request.method === 'POST') return action.promise;
      return mutationReply(request);
    };
    await loaded(handler);

    await fireEvent.press(screen.getByTestId('plan-accept'));
    await waitFor(() => expect(harness!.server.matching('POST', /\/plans\/2030-03-29\/actions$/)).toHaveLength(1));
    await fireEvent.press(screen.getByTestId('gate-delete'));
    await waitFor(() => expect(harness!.server.matching('DELETE', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(1));
    await act(async () => action.resolve({ status: 200, body: planEnvelope(planWithBasis(TODAY, BASIS_ID, { status: 'accepted' })) }));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull());
  });

  it('M5B2A-026 a week accept for an uncached date begun before edit success stays filtered', async () => {
    const accept = deferred<RouteReply>();
    const handler: RouteHandler = request => {
      if (request.path === '/api/mobile/plans/week/accept' && request.method === 'POST') return accept.promise;
      if (request.path === `/api/mobile/plans/${FUTURE}` && request.method === 'GET') {
        return { status: 500, body: { success: false, error: 'offline' } };
      }
      return mutationReply(request);
    };
    harness = await prepare('en', initialState(), handler);
    noRetries(harness);
    const view = await render(<Providers harness={harness}><View>
      <WeekAcceptDriver />
      <MemoryMutationDriver />
    </View></Providers>);

    await fireEvent.press(screen.getByTestId('gate-week-accept'));
    await waitFor(() => expect(harness!.server.matching('POST', /^\/api\/mobile\/plans\/week\/accept$/)).toHaveLength(1));
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await waitFor(() => expect(harness!.server.matching('PATCH', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(1));
    await act(async () => accept.resolve({ status: 200, body: weekEnvelope() }));
    expect(harness.client.getQueryData(queryKeys.plan(ACCOUNT_A.uid, FUTURE))).toEqual(expect.objectContaining({ memoryBasis: expect.any(Object) }));

    await view.rerender(<Providers harness={harness}><PlanScreen date={FUTURE} onBack={() => undefined} /></Providers>);
    await waitFor(() => expect(harness!.server.matching('GET', new RegExp(`/plans/${FUTURE}$`))).toHaveLength(1));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  // GA-M5B2A-AMEND-6 (Claude, M5B2A-R28-001): delete-all *cancels* a pending
  // undo delete instead of flushing it. The all-scope deletion takes that row,
  // and a single delete sent beside the purge could land its dismissal after the
  // purge reported done. Only the delete-all request goes out.
  it('M5B2A-020 delete-all takes over a pending undo delete and the deleted basis never reappears', async () => {
    const one = deferred<RouteReply>();
    const all = deferred<RouteReply>();
    // GA-M5B2A-AMEND-3 (Claude): once memory is deleted, the server's plan
    // answer names no basis (the record is gone); answering the old basis
    // after the deletion is a state the server cannot emit.
    let deleted = false;
    void all.promise.then(() => { deleted = true; });
    const handler: RouteHandler = request => {
      if (deleted && /^\/api\/mobile\/plans\/\d{4}-\d{2}-\d{2}$/.test(request.path) && request.method === 'GET') {
        return { status: 200, body: planEnvelope({ ...planWithBasis(TODAY), memoryBasis: null }) };
      }
      if (planGet(request)) return planGet(request);
      if (request.path === `/api/mobile/memory/${BASIS_ID}` && request.method === 'DELETE') return one.promise;
      if (request.path === '/api/mobile/memory' && request.method === 'DELETE') return all.promise;
      return undefined;
    };
    harness = await prepare('en', initialState({ memoryItems: [memoryItem(BASIS_ID), memoryItem('other-memory')] }), handler);
    noRetries(harness);
    await render(<Providers harness={harness}><View>
      <PlanScreen date={TODAY} onBack={() => undefined} />
      <MemoryScreen onBack={() => undefined} />
    </View></Providers>);
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());

    await fireEvent.press(screen.getByTestId(`memory-screen-delete-${BASIS_ID}`));
    expect(harness.server.matching('DELETE', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(0);
    expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull();
    await fireEvent.press(screen.getByTestId('memory-screen-delete-all'));
    await fireEvent.press(screen.getByTestId('memory-screen-delete-all-confirm'));
    await waitFor(() => expect(harness!.server.matching('DELETE', /\/api\/mobile\/memory$/)).toHaveLength(1));
    expect(harness.server.matching('DELETE', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(0);
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    await act(async () => { all.resolve({ status: 200, body: { success: true, deleted: 2 } }); await jest.advanceTimersByTimeAsync(30_000); });
    expect(harness.server.matching('DELETE', new RegExp(`/memory/${BASIS_ID}$`))).toHaveLength(0);
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    void one;
  });

  const overlapCases: [string, 'patch' | 'delete'][] = [
    ['patch then delete', 'patch'],
    ['delete then patch', 'delete'],
  ];

  it.each(overlapCases)('M5B2A-026 overlap %s with failed refetch never resurrects the basis', async (_case, first) => {
    const patch = deferred<RouteReply>();
    const remove = deferred<RouteReply>();
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
        reads += 1;
        return reads === 1 ? planGet(request) : { status: 500, body: { success: false, error: 'offline' } };
      }
      if (request.path === `/api/mobile/memory/${BASIS_ID}` && request.method === 'PATCH') return patch.promise;
      if (request.path === `/api/mobile/memory/${BASIS_ID}` && request.method === 'DELETE') return remove.promise;
      return undefined;
    };
    await loaded(handler);
    await fireEvent.press(screen.getByTestId('gate-patch'));
    await fireEvent.press(screen.getByTestId('gate-delete'));
    await waitFor(() => expect(harness!.server.matching('PATCH', /\/memory\/memory-focus$/)).toHaveLength(1));
    await waitFor(() => expect(harness!.server.matching('DELETE', /\/memory\/memory-focus$/)).toHaveLength(1));

    const firstReply = first === 'patch' ? patch : remove;
    const secondReply = first === 'patch' ? remove : patch;
    await act(async () => firstReply.resolve(first === 'patch'
      ? { status: 200, body: { success: true, memory: memoryItem('replacement') } }
      : { status: 200, body: { success: true, deleted: 1 } }));
    await act(async () => secondReply.resolve(first === 'patch'
      ? { status: 200, body: { success: true, deleted: 1 } }
      : { status: 200, body: { success: true, memory: memoryItem('replacement') } }));
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });

  it.each(['patch', 'delete', 'delete-all'] as const)('M5B2A-021 failed %s restores the basis with no plan refetch', async operation => {
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') { reads += 1; return planGet(request); }
      const expectedMethod = operation === 'patch' ? 'PATCH' : 'DELETE';
      const expectedPath = operation === 'delete-all' ? '/api/mobile/memory' : `/api/mobile/memory/${BASIS_ID}`;
      if (request.method === expectedMethod && request.path === expectedPath) {
        // GA-M5B2A-AMEND-8 (Claude): refused, not a 500 that may have committed.
        return { status: 400, body: { success: false, error: 'invalid' } };
      }
      return undefined;
    };
    await loaded(handler);
    const before = reads;
    await fireEvent.press(screen.getByTestId(operation === 'patch' ? 'gate-patch' : operation === 'delete' ? 'gate-delete' : 'gate-delete-all'));
    await waitFor(() => expect(harness!.server.matching(operation === 'patch' ? 'PATCH' : 'DELETE', operation === 'delete-all' ? /^\/api\/mobile\/memory$/ : /\/memory\/memory-focus$/)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByTestId('m5b-plan-memory-basis')).not.toBeNull());
    expect(reads).toBe(before);
  });

  it('M5B2A-023 a correction made offline hides the basis while it waits, and after it lands', async () => {
    // GA-M5B2A-AMEND-4 (Claude): offline, TanStack holds a mutation until the
    // connection returns, so no PATCH is sent while offline; the line is hidden
    // from the tap, through the wait, and after the PATCH lands with a plan
    // refetch that fails.
    let reads = 0;
    const handler: RouteHandler = request => {
      if (request.path === `/api/mobile/plans/${TODAY}` && request.method === 'GET') {
        reads += 1;
        return reads === 1 ? planGet(request) : { status: 500, body: { success: false, error: 'offline' } };
      }
      return mutationReply(request);
    };
    await loaded(handler);
    onlineManager.setOnline(false);
    await fireEvent.press(screen.getByTestId('gate-patch'));
    expect(harness!.server.matching('PATCH', /\/memory\/memory-focus$/)).toHaveLength(0);
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
    await act(async () => { onlineManager.setOnline(true); });
    await waitFor(() => expect(harness!.server.matching('PATCH', /\/memory\/memory-focus$/)).toHaveLength(1));
    expect(screen.queryByTestId('m5b-plan-memory-basis')).toBeNull();
  });
});

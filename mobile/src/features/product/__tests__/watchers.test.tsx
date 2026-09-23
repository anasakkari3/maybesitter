import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { watcherChangedSchema, watcherListSchema } from '../../../api/schemas/watchers';
import { pauseWatcher, deleteWatcher } from '../../../api/endpoints/watchers';
import { useWatcherAction, watcherKey } from '../useWatchers';
import response from './watcher-route-response.json';

jest.mock('../../../api/queries', () => ({ useUid: () => 'account-a' }));
jest.mock('../../../api/endpoints/watchers', () => ({ pauseWatcher: jest.fn(), deleteWatcher: jest.fn(), listWatchers: jest.fn() }));
const pause = jest.mocked(pauseWatcher);
const remove = jest.mocked(deleteWatcher);
beforeEach(() => { jest.clearAllMocks(); });
describe('watcher mobile boundary', () => {
  it('parses an actual local route response and rejects unrecognised runtime states', () => {
    expect(watcherChangedSchema.parse(response).watcher.source.signalKind).toBe('readiness');
    expect(watcherListSchema.parse({ success: true, items: [response.watcher] }).items).toHaveLength(1);
    expect(watcherChangedSchema.safeParse({ ...response, watcher: { ...response.watcher, status: 'delivered' } }).success).toBe(false);
  });
  it('does not retry a failed action or mutate cached state optimistically', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(watcherKey('account-a'), { items: [response.watcher] });
    pause.mockRejectedValueOnce(new Error('offline'));
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = await renderHook(() => useWatcherAction(), { wrapper });
    await act(async () => { try { await result.current.mutateAsync({ id: response.watcher.watcherId, action: 'pause' }); } catch {} });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(pause).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(watcherKey('account-a'))).toEqual({ items: [response.watcher] });
    client.clear();
  });
  it('invalidates only the active account after a confirmed deletion', async () => {
    const client = new QueryClient();
    client.setQueryData(watcherKey('account-a'), { items: [response.watcher] });
    client.setQueryData(watcherKey('account-b'), { items: [] });
    remove.mockResolvedValueOnce({ success: true, watcherId: response.watcher.watcherId, deleted: true });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = await renderHook(() => useWatcherAction(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ id: response.watcher.watcherId, action: 'delete' }); });
    expect(client.getQueryState(watcherKey('account-a'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(watcherKey('account-b'))?.isInvalidated).toBe(false);
    expect(pause).not.toHaveBeenCalled();
    client.clear();
  });
});

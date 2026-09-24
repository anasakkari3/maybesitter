import React from 'react';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { watcherChangedSchema, watcherListSchema } from '../../../api/schemas/watchers';
import { pauseWatcher, deleteWatcher } from '../../../api/endpoints/watchers';
import { backgroundActivitySchema, backgroundAttributionSchema } from '../../../api/schemas/backgroundActivity';
import { setBackgroundActivityPaused } from '../../../api/endpoints/backgroundActivity';
import { backgroundActivityKey, monitoringKey, useSetBackgroundActivityPaused, useWatcherAction, watcherKey } from '../useWatchers';
import response from './watcher-route-response.json';

jest.mock('../../../api/queries', () => ({ useUid: () => 'account-a' }));
jest.mock('../../../api/endpoints/watchers', () => ({ pauseWatcher: jest.fn(), deleteWatcher: jest.fn(), listWatchers: jest.fn() }));
jest.mock('../../../api/endpoints/backgroundActivity', () => ({
  getBackgroundActivity: jest.fn(),
  getBackgroundAttribution: jest.fn(),
  setBackgroundActivityPaused: jest.fn(),
}));
const pause = jest.mocked(pauseWatcher);
const remove = jest.mocked(deleteWatcher);
const setPaused = jest.mocked(setBackgroundActivityPaused);
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

  it('parses the canonical monitor projection and its complete attribution chain', () => {
    const activity = backgroundActivitySchema.parse({
      success: true,
      schemaVersion: 'background-monitor-v1',
      paused: false,
      monitors: [{
        monitorId: 'watcher:w-1', watcherId: 'w-1', connectionId: null,
        label: 'maybesitter:readiness', title: null, status: 'active', purpose: 'notice_threshold_crossed',
        effects: ['notify'], lastCheckedAt: '2026-09-23T09:00:00.000Z',
        lastChangedAt: null, nextCheckAt: '2026-09-23T09:30:00.000Z', canPause: true, canDelete: true,
      }],
    });
    expect(activity.monitors[0]?.watcherId).toBe('w-1');
    const attribution = backgroundAttributionSchema.parse({
      success: true,
      schemaVersion: 'background-monitor-v1',
      orphanCount: 0,
      actions: [{
        actionId: 'action-1', monitorId: 'watcher:w-1', watcherId: 'w-1', label: 'maybesitter:readiness',
        observedAt: '2026-09-23T09:00:00.000Z', occurredAt: '2026-09-23T09:00:01.000Z',
        condition: 'readiness_below_threshold', capability: 'notification', policyDecision: 'allowed',
        effect: 'notify', artifact: { kind: 'notification', ref: 'notification-1' },
      }],
    });
    expect(attribution.orphanCount).toBe(0);
    expect(attribution.actions[0]?.artifact.ref).toBe('notification-1');
  });

  it('stores global pause state only in the signed-in account cache', async () => {
    const activity = backgroundActivitySchema.parse({
      success: true, schemaVersion: 'background-monitor-v1', paused: true, monitors: [],
    });
    setPaused.mockResolvedValueOnce(activity);
    const client = new QueryClient();
    client.setQueryData(backgroundActivityKey('account-b'), { ...activity, paused: false });
    client.setQueryData(monitoringKey('account-b'), { paused: false, updatedAt: null });
    const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = await renderHook(() => useSetBackgroundActivityPaused(), { wrapper });
    await act(async () => { await result.current.mutateAsync(true); });
    expect(setPaused).toHaveBeenCalledWith(true, expect.any(Object));
    expect(client.getQueryData(backgroundActivityKey('account-a'))).toEqual(activity);
    expect(client.getQueryData(monitoringKey('account-a'))).toEqual({ paused: true, updatedAt: null });
    expect(client.getQueryData(backgroundActivityKey('account-b'))).toEqual({ ...activity, paused: false });
    client.clear();
  });
});

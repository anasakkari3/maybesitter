import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUid } from '../../api/queries';
import { createReadinessWatcher, deleteWatcher, getMonitoringSettings, listWatchers, pauseWatcher, putMonitoringSettings } from '../../api/endpoints/watchers';
import {
  getBackgroundActivity,
  getBackgroundActivityHistory,
  getBackgroundAttribution,
  setBackgroundActivityPaused,
} from '../../api/endpoints/backgroundActivity';
import type { WatcherEffect } from '../../api/schemas/watchers';
export const watcherKey = (uid: string) => ['user', uid, 'watchers'] as const;
export const monitoringKey = (uid: string) => ['user', uid, 'monitoringSettings'] as const;
export const backgroundActivityKey = (uid: string) => ['user', uid, 'backgroundActivity'] as const;
export const backgroundActivityHistoryKey = (
  uid: string,
  filters?: { watcherId?: string | undefined; kind?: string | undefined },
) => ['user', uid, 'backgroundActivityHistory', filters] as const;
export const backgroundAttributionKey = (uid: string) => ['user', uid, 'backgroundAttribution'] as const;
export function useWatchers() {
  const uid = useUid();
  return useQuery({ queryKey: watcherKey(uid), queryFn: listWatchers, enabled: uid !== 'signed-out' });
}
export function useWatcherAction() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; action: 'pause'|'resume'|'delete' }) => {
      if (input.action === 'delete') await deleteWatcher(input.id);
      else await pauseWatcher(input.id, input.action === 'pause');
    },
    retry: false,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: watcherKey(uid) });
      void client.invalidateQueries({ queryKey: backgroundActivityKey(uid) });
      void client.invalidateQueries({ queryKey: backgroundAttributionKey(uid) });
      void client.invalidateQueries({ queryKey: ['user', uid, 'backgroundActivityHistory'] });
    },
  });
}

export function useCreateReadinessWatcher() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (effect: WatcherEffect) => createReadinessWatcher(effect),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: watcherKey(uid) });
      void client.invalidateQueries({ queryKey: backgroundActivityKey(uid) });
    },
  });
}

export function useMonitoringSettings() {
  const uid = useUid();
  return useQuery({ queryKey: monitoringKey(uid), queryFn: getMonitoringSettings, enabled: uid !== 'signed-out' });
}

export function useSetMonitoringSettings() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paused: boolean) => putMonitoringSettings(paused),
    onSuccess: settings => { client.setQueryData(monitoringKey(uid), settings); },
  });
}

export function useBackgroundActivity() {
  const uid = useUid();
  return useQuery({ queryKey: backgroundActivityKey(uid), queryFn: getBackgroundActivity, enabled: uid !== 'signed-out' });
}

export function useBackgroundAttribution() {
  const uid = useUid();
  return useQuery({ queryKey: backgroundAttributionKey(uid), queryFn: getBackgroundAttribution, enabled: uid !== 'signed-out' });
}

export function useBackgroundActivityHistory(filters?: {
  limit?: number | undefined;
  watcherId?: string | undefined;
  kind?: string | undefined;
}) {
  const uid = useUid();
  return useQuery({
    queryKey: backgroundActivityHistoryKey(uid, { watcherId: filters?.watcherId, kind: filters?.kind }),
    queryFn: () => getBackgroundActivityHistory(filters),
    enabled: uid !== 'signed-out',
  });
}

export function useSetBackgroundActivityPaused() {
  const uid = useUid();
  const client = useQueryClient();
  return useMutation({
    mutationFn: setBackgroundActivityPaused,
    onSuccess: activity => {
      client.setQueryData(backgroundActivityKey(uid), activity);
      client.setQueryData(monitoringKey(uid), { paused: activity.paused, updatedAt: null });
      void client.invalidateQueries({ queryKey: ['user', uid, 'backgroundActivityHistory'] });
    },
  });
}

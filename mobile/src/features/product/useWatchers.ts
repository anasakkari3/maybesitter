import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useUid } from '../../api/queries';
import { deleteWatcher, listWatchers, pauseWatcher } from '../../api/endpoints/watchers';
export const watcherKey = (uid: string) => ['user', uid, 'watchers'] as const;
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
    onSuccess: () => { void client.invalidateQueries({ queryKey: watcherKey(uid) }); },
  });
}

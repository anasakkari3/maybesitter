import { useQuery } from '@tanstack/react-query';
import { getM6Capabilities } from '../../api/endpoints/m6';
import { FeatureUnavailableError } from '../../api/errors';
import type { M6Capabilities } from '../../api/schemas/m6';
import { useUid } from '../../api/queries';

/**
 * M6a-1's probe: `null` is unknown (no answer yet, or the latest refetch
 * failed), `false` is today's behaviour, `true` turns the server search on.
 * Fails closed on a failed refetch, as M4b and M5b do.
 */
const FIVE_MINUTES = 5 * 60_000;
const OFF: M6Capabilities = { success: true, searchHistory: false, memoryTranslation: false };

async function probe(uid: string): Promise<M6Capabilities> {
  try {
    return await getM6Capabilities({ asUid: uid });
  } catch (error) {
    if (error instanceof FeatureUnavailableError) return OFF;
    throw error;
  }
}

export const m6CapabilitiesKey = (uid: string) => ['user', uid, 'm6Capabilities'] as const;

function useM6Capabilities(): M6Capabilities | null {
  const uid = useUid();
  const query = useQuery({
    queryKey: m6CapabilitiesKey(uid),
    queryFn: () => probe(uid),
    enabled: uid !== 'signed-out',
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return query.status === 'success' && !query.isRefetchError ? query.data : null;
}

export function useSearchHistoryOn(): boolean | null {
  const capabilities = useM6Capabilities();
  return capabilities === null ? null : capabilities.searchHistory;
}

/** M6a-2: `null` is unknown, and unknown asks nothing (PLAN-M6a-2 R2). */
export function useMemoryTranslationOn(): boolean | null {
  const capabilities = useM6Capabilities();
  return capabilities === null ? null : capabilities.memoryTranslation === true;
}

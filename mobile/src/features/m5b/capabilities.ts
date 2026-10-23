import { useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getM5bCapabilities } from '../../api/endpoints/m5b';
import { FeatureUnavailableError } from '../../api/errors';
import type { M5bCapabilities } from '../../api/schemas/m5b';
import { useUid } from '../../api/queries';

/**
 * M5b-1's capability probe, in three states: `null` is unknown (no
 * successful answer yet, or the latest refetch failed); known `false` is today's behaviour
 * exactly; known `true` turns the M5b-1 surfaces on. A `404
 * feature_unavailable` is a known off. Refetched on focus and every five
 * minutes, so a kill switch reaches an open screen within five minutes.
 */
const FIVE_MINUTES = 5 * 60_000;
const OFF: M5bCapabilities = { success: true, memoryLearning: false };

async function probe(uid: string): Promise<M5bCapabilities> {
  try {
    return await getM5bCapabilities({ asUid: uid });
  } catch (error) {
    if (error instanceof FeatureUnavailableError) return OFF;
    throw error;
  }
}

export const m5bCapabilitiesKey = (uid: string) => ['user', uid, 'm5bCapabilities'] as const;

/**
 * The probe's two readings (M5b-2b-1, R13-001): `now` is useM5bOn's answer —
 * true / false when known, null while unknown, and null again after a failed
 * refetch (fail closed, M5B-A-002); `lastKnown` is the latest answer the
 * server did give, kept through a failed refetch, or undefined if none yet.
 * Asked again on every focus, not only once stale: a mode switch on the
 * server reaches a screen that is brought back (R12-001).
 */
export function useM5bCapabilityState(): { now: boolean | null; lastKnown: boolean | undefined } {
  const uid = useUid();
  const query = useQuery({
    queryKey: m5bCapabilitiesKey(uid),
    queryFn: () => probe(uid),
    enabled: uid !== 'signed-out',
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
  // Fail closed on a failed refetch (M5B-A-002, as M4b): an earlier `true`
  // is not an answer about now, and unknown draws nothing new.
  return {
    now: query.status === 'success' && !query.isRefetchError ? query.data.memoryLearning : null,
    lastKnown: query.data?.memoryLearning,
  };
}

/** True / false when known; null while unknown. */
export function useM5bOn(): boolean | null {
  return useM5bCapabilityState().now;
}

/**
 * The same two readings, from the cache at the moment of the call — for a
 * read that stamps what was known when it started and when it answered.
 */
export function m5bCapabilitySnapshot(client: QueryClient, uid: string): { now: boolean | null; lastKnown: boolean | undefined } {
  const state = client.getQueryState<M5bCapabilities>(m5bCapabilitiesKey(uid));
  return {
    now: state?.status === 'success' && state.data !== undefined ? state.data.memoryLearning : null,
    lastKnown: state?.data?.memoryLearning,
  };
}

/** How long a tap waits for a fresh answer before it refuses. */
export const M5B_FRESH_PROBE_MS = 1_500;

/**
 * A fresh probe right before a tap that changes what M5b-1 does — a request of
 * its own, never a background refetch already in flight (the M5a lesson,
 * M5A-R11-001). Null is unknown, and unknown takes no action.
 */
export function useFreshM5bOn(): () => Promise<boolean | null> {
  const client = useQueryClient();
  const uid = useUid();
  return useCallback(async () => {
    if (uid === 'signed-out') return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), M5B_FRESH_PROBE_MS); });
    const fresh = probe(uid)
      .then((answer) => {
        client.setQueryData(m5bCapabilitiesKey(uid), answer);
        return answer.memoryLearning;
      })
      .catch(() => null);
    try {
      return await Promise.race([fresh, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, [client, uid]);
}

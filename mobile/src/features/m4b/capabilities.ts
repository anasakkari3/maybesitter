import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getM4bCapabilities } from '../../api/endpoints/m4b';
import type { M4bCapabilities } from '../../api/schemas/m4b';
import { useUid } from '../../api/queries';

/**
 * M4b's capability probe (PLAN R3.3, M4B-REV-007, M4B-R2-005).
 *
 * Fails closed: only the latest *successful* answer turns anything on. A
 * pending probe, an error, or a refetch that failed after an earlier success
 * all read as "off", so every M4b surface shows today's screen exactly.
 *
 * It is refetched on focus and every five minutes while a gated surface is
 * mounted, so a kill switch reaches an open screen within five minutes.
 */
export type M4bCapability = 'externalClashHold' | 'eveningImpact' | 'smartPostpone';

const FIVE_MINUTES = 5 * 60_000;
/** How long a semantics-changing interaction waits for a fresh answer. */
export const FRESH_PROBE_MS = 1_500;

export const m4bCapabilitiesKey = (uid: string) => ['user', uid, 'm4bCapabilities'] as const;

export function useM4bCapabilities(): M4bCapabilities | null {
  const uid = useUid();
  const query = useQuery({
    queryKey: m4bCapabilitiesKey(uid),
    queryFn: getM4bCapabilities,
    enabled: uid !== 'signed-out',
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return query.status === 'success' && !query.isRefetchError ? query.data : null;
}

/** Whether one capability is on, by the latest successful probe. */
export function useM4bCapability(name: M4bCapability): boolean {
  return useM4bCapabilities()?.[name] === true;
}

/**
 * A fresh probe for an interaction that changes what a tap does (the Today
 * row's postpone, opening the slot sheet): a cached `true` alone never
 * changes behaviour. Resolves `false` on an error or after 1.5 s.
 */
export function useFreshM4bCapability(): (name: M4bCapability) => Promise<boolean> {
  const client = useQueryClient();
  const uid = useUid();
  return useCallback(async (name: M4bCapability) => {
    if (uid === 'signed-out') return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), FRESH_PROBE_MS); });
    const fresh = client
      .fetchQuery({ queryKey: m4bCapabilitiesKey(uid), queryFn: getM4bCapabilities, staleTime: 0, retry: false })
      .then((answer) => answer[name] === true)
      .catch(() => false);
    try {
      return await Promise.race([fresh, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, [client, uid]);
}

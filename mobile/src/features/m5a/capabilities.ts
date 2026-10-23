import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getM5aCapabilities } from '../../api/endpoints/m5a';
import { FeatureUnavailableError } from '../../api/errors';
import type { M5aCapabilities } from '../../api/schemas/m5a';
import { useUid } from '../../api/queries';

/**
 * M5a's capability probe, in three states (M5A-R2-002).
 *
 * `null` is **unknown**: no successful answer yet this session, or only
 * errors; a refetch that fails keeps the last successful answer. A
 * never-enrolled phone reads no calendar while it is unknown — privacy on an
 * unknown probe beats off-state timing parity. Known `false`
 * is today's behaviour exactly; known `true` turns the M5a surfaces on.
 *
 * Refetched on focus and every five minutes, like M4b's, so a kill switch
 * reaches an open screen within five minutes. An enrolled phone never goes
 * back to the old calendar behaviour whatever this says (M5A-R2-003).
 */
const FIVE_MINUTES = 5 * 60_000;

const OFF: M5aCapabilities = { success: true, calendarChoice: false, emailSources: false };

/**
 * The probe, where a server that answers `404 feature_unavailable` has said
 * the feature is off — a known answer, like every other gated module. Any
 * other failure stays unknown.
 */
async function probe(uid: string, signal?: AbortSignal): Promise<M5aCapabilities> {
  try {
    return await getM5aCapabilities({ asUid: uid, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof FeatureUnavailableError) return OFF;
    throw error;
  }
}

export const m5aCapabilitiesKey = (uid: string) => ['user', uid, 'm5aCapabilities'] as const;

export function useM5aCapabilities(): M5aCapabilities | null {
  const uid = useUid();
  const query = useQuery({
    queryKey: m5aCapabilitiesKey(uid),
    queryFn: ({ signal }) => probe(uid, signal),
    enabled: uid !== 'signed-out',
    staleTime: FIVE_MINUTES,
    refetchInterval: FIVE_MINUTES,
    refetchOnWindowFocus: true,
    retry: false,
  });
  // The latest successful answer this session stands through a failed
  // background refetch (M5A-R2-002); only an account with no successful answer
  // yet is unknown.
  return query.data ?? null;
}

/** For a headless pass: the cached answer if fresh, else one probe. Null when unknown. */
export async function fetchM5aCapabilities(client: QueryClient, uid: string): Promise<M5aCapabilities | null> {
  try {
    return await client.fetchQuery({
      queryKey: m5aCapabilitiesKey(uid),
      queryFn: ({ signal }) => probe(uid, signal),
      staleTime: 60_000,
      retry: false,
    });
  } catch {
    return null;
  }
}

/** The newest fresh probe per query client; only it may write the cache. */
const freshProbeGeneration = new WeakMap<QueryClient, number>();

/** How long a tap waits for a fresh answer before it refuses (PLAN-M5a R1.1). */
export const M5A_FRESH_PROBE_MS = 1_500;

/**
 * A fresh probe right before a tap that changes what M5a does (M5A-R10-001):
 * no cache, no retry, 1.5 s. True or false is the server's answer now (and the
 * cached answer is replaced, so the screen redraws for it); null is unknown,
 * and an unknown answer takes no action of either kind.
 */
export function useFreshM5aCapability(): (name: keyof Omit<M5aCapabilities, 'success'>) => Promise<boolean | null> {
  const client = useQueryClient();
  const uid = useUid();
  return useCallback(async (name) => {
    if (uid === 'signed-out') return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A probe that lost to the timeout is aborted and may no longer write: a
    // newer answer may be cached by then (FU-S-R1-001). Of overlapping fresh
    // probes, only the latest writes.
    const controller = new AbortController();
    let expired = false;
    const generation = (freshProbeGeneration.get(client) ?? 0) + 1;
    freshProbeGeneration.set(client, generation);
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => { expired = true; controller.abort(); resolve(null); }, M5A_FRESH_PROBE_MS);
    });
    // A request of its own (M5A-R11-001): sharing the query's key would hand
    // back a background refetch already in flight — an answer from before the
    // tap. The fresh answer then replaces the cached one — after that older
    // refetch is cancelled, or it would land afterwards and put the
    // pre-tap answer back on screen (M5A-R12-F01).
    const fresh = probe(uid, controller.signal)
      .then(async (answer) => {
        if (expired || freshProbeGeneration.get(client) !== generation) return null;
        await client.cancelQueries({ queryKey: m5aCapabilitiesKey(uid), exact: true });
        if (expired || freshProbeGeneration.get(client) !== generation) return null;
        client.setQueryData(m5aCapabilitiesKey(uid), answer);
        return answer[name] === true;
      })
      .catch(() => null);
    try {
      return await Promise.race([fresh, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }, [client, uid]);
}

/** The refusal a tap shows when the fresh answer says M5a email is not there now. */
export const M5A_NOT_NOW = () => new FeatureUnavailableError('email sources are not available now');

export function useFetchM5aCapabilities(): () => Promise<M5aCapabilities | null> {
  const client = useQueryClient();
  const uid = useUid();
  return useCallback(() => fetchM5aCapabilities(client, uid), [client, uid]);
}

/**
 * The same answer for a screen that only needs it when it opens and when the
 * app comes back to the front — the calendar screen, whose layout changes only
 * at enrolment. Read through the shared query without subscribing to it, so the
 * screen does not keep a refetch timer of its own. Null while unknown.
 */
export function useM5aCapabilitiesOnOpen(): M5aCapabilities | null {
  const client = useQueryClient();
  const uid = useUid();
  const [answer, setAnswer] = useState<{ uid: string; value: M5aCapabilities | null } | null>(null);
  useEffect(() => {
    if (uid === 'signed-out') return undefined;
    let alive = true;
    const read = () => {
      void fetchM5aCapabilities(client, uid).then((value) => { if (alive) setAnswer({ uid, value }); });
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') read(); });
    return () => {
      alive = false;
      subscription.remove();
    };
  }, [client, uid]);
  return answer?.uid === uid ? answer.value : null;
}

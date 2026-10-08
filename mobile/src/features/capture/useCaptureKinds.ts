import React from 'react';
import { QueryClient, QueryClientContext, useQuery } from '@tanstack/react-query';
import { getCaptureKinds } from '../../api/endpoints/capture';
import type { CaptureEntry } from '../../api/schemas/capture';
import { useOptionalAuth } from '../../auth/AuthProvider';

/**
 * Stands in only where a screen is drawn with no query client at all (a
 * screen test that mocks the queries): the probe is then never asked, and the
 * page keeps today's paths. In the app the provider is always there.
 */
const NO_CLIENT = new QueryClient();

/**
 * Which chat entries the server offers (M3b, R004): the goals, habits and
 * thoughts pages read this one hook before they draw a create path.
 *
 * - **Pending** means "draw neither".
 * - A switched-off feature (404), a network failure, any other error, or no
 *   query client at all means "keep today's paths" — the safe side.
 *
 * Keyed by account under `['user', uid, …]`, so an account change clears it
 * with the rest of the cache (#148), and never retried on its own.
 */
export function useCaptureKinds(): { pending: boolean; entries: readonly CaptureEntry[] } {
  const uid = useOptionalAuth()?.user?.uid ?? 'signed-out';
  const context = React.useContext(QueryClientContext);
  const query = useQuery({
    queryKey: ['user', uid, 'captureKinds'],
    queryFn: getCaptureKinds,
    enabled: context !== undefined && uid !== 'signed-out',
    retry: false,
    staleTime: 5 * 60_000,
  }, context ?? NO_CLIENT);
  if (context === undefined || uid === 'signed-out') return { pending: false, entries: [] };
  if (query.isPending) return { pending: true, entries: [] };
  return { pending: false, entries: query.data ?? [] };
}

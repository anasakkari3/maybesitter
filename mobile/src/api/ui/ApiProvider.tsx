import React, { useEffect, useRef, useState } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { useAuth } from '../../auth/AuthProvider';
import { setAuthRepository } from '../auth';
import { createAppQueryClient, installDeviceManagers } from '../queryClient';

/**
 * Everything the API layer needs from React, in one place.
 *
 * ── Clearing the cache on a uid change (#148) ────────────────────
 *
 * Signing out of A and into B on the same device must not show B a single row
 * of A's data — not on the screen that was already open, not for one frame
 * before the refetch lands. Query keys are scoped by uid, which already makes
 * a collision impossible; the cache is *also* cleared outright here, because
 * the cost is one refetch and the failure mode is somebody reading somebody
 * else's commitments.
 *
 * It runs on every uid change, sign-out included, so a signed-out device holds
 * nothing in memory either.
 */
export function ApiProvider({
  children,
  /** Tests pass their own so they can clear it between cases. */
  client,
}: {
  children: React.ReactNode;
  client?: QueryClient;
}) {
  const { repository, user, status } = useAuth();
  // A stable identity (see AppContext), so it can be a dependency rather than
  // smuggled through a ref.
  const { resetForNewUser } = useApp().actions;
  const [defaultClient] = useState(createAppQueryClient);
  const queryClient = client ?? defaultClient;
  const uid = user?.uid ?? null;
  const previousUid = useRef<string | null | undefined>(undefined);

  // The client layer has no React in scope — a 401 refresh happens inside
  // `apiRequest` — so the repository is handed to it as a module singleton.
  useEffect(() => {
    setAuthRepository(repository);
    return () => setAuthRepository(null);
  }, [repository]);

  useEffect(() => installDeviceManagers(), []);

  useEffect(() => {
    // Nothing is recorded, and nothing is cleared, until Firebase has actually
    // answered. On a cold start the uid goes null → alice as the SDK resolves,
    // and treating that as an account switch would clear the cache — and
    // cancel the queries that had just mounted — on every single launch.
    if (status === 'loading') return;
    if (previousUid.current !== undefined && previousUid.current !== uid) {
      queryClient.clear();
      resetForNewUser();
    }
    previousUid.current = uid;
  }, [status, uid, queryClient, resetForNewUser]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

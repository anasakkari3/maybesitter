import { AppState, type AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { isRetryable } from './errors';

/**
 * The one QueryClient, and the two device facts it has to know about.
 *
 * ── Nothing is written to disk ───────────────────────────────────
 *
 * There is no persister. A commitment title is the most personal thing this
 * app holds, and AsyncStorage is not encrypted on either platform. The cost is
 * a cold start with no data; the alternative is an unencrypted copy of the
 * user's life surviving until someone clears app data. `noStorage.test.ts`
 * asserts the query layer never touches AsyncStorage.
 *
 * There is no offline mutation queue either. A confirmation replayed hours
 * later, without the user present, is exactly what UC-1.R4 (#157) forbids.
 *
 * ── Retries ──────────────────────────────────────────────────────
 *
 * Queries retry twice, and only for failures another attempt can fix: no
 * signal, a timeout, a 5xx. A 400 or a 404 is not going to become a 200.
 * Mutations never retry at all — the caller decides, because only the caller
 * knows whether repeating the call is safe.
 */

export const STALE_TIME_MS = 30_000;
export const MAX_QUERY_RETRIES = 2;

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        retry: (failureCount, error) => failureCount < MAX_QUERY_RETRIES && isRetryable(error),
        retryDelay: attempt => Math.min(1000 * 2 ** attempt, 8000),
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Teaches React Query what "online" and "focused" mean on a phone.
 *
 * Without these it assumes a browser: `navigator.onLine` and a `window` focus
 * event, neither of which exists here. The result would be a client that never
 * refetches when the user comes back to the app or the signal returns —
 * which is most of what #148 asks for.
 *
 * Returns a teardown, so a test can install and remove them cleanly.
 */
export function installDeviceManagers(): () => void {
  // `setEventListener` is typed as returning void, but it does hand back the
  // unsubscribe its callback returned, so the teardown is captured here.
  let unsubscribeNetwork: (() => void) | undefined;
  onlineManager.setEventListener(setOnline => {
    unsubscribeNetwork = NetInfo.addEventListener(state => {
      // `isInternetReachable` is null until the first probe finishes; treating
      // null as offline would flash the offline banner on every cold start.
      setOnline(state.isConnected === true && state.isInternetReachable !== false);
    });
    return unsubscribeNetwork;
  });

  const subscription = AppState.addEventListener('change', (status: AppStateStatus) => {
    focusManager.setFocused(status === 'active');
  });

  return () => {
    unsubscribeNetwork?.();
    subscription.remove();
  };
}

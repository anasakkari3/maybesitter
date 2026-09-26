/**
 * What each place reminder is doing on this phone, for the screens (closure CL4).
 *
 * Published from the armed store whenever it is written — by the in-app
 * reconcile, and by the region task when a reminder rings while the app is
 * alive — so the details screen can say "waiting for a free slot" or "already
 * rang" instead of drawing every reminder as simply set. Read lazily from
 * storage the first time a screen asks, for a screen drawn before the first
 * reconcile of this launch. Holds ids and states only.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { loadArmed, type ArmedStore } from '../../lib/deviceSettings/placeReminders';
import { watchStates, type WatchState } from './placeReminderEngine';

interface Status { readonly accountId: string; readonly states: ReadonlyMap<string, WatchState> }

let status: Status | null = null;
let published = false;
const listeners = new Set<() => void>();

export function publishWatchStatus(store: ArmedStore | null): void {
  published = true;
  status = store ? { accountId: store.accountId, states: watchStates(store.entries) } : null;
  for (const listener of [...listeners]) listener();
}

export function watchStateOf(accountId: string | null, commitmentId: string): WatchState | null {
  if (!accountId || !status || status.accountId !== accountId) return null;
  return status.states.get(commitmentId) ?? null;
}

let loading: Promise<void> | null = null;
function ensureLoaded(): void {
  if (published || loading) return;
  loading = loadArmed().then(store => {
    loading = null;
    if (!published) publishWatchStatus(store);
  });
}

export function useWatchState(accountId: string | null, commitmentId: string): WatchState | null {
  useEffect(ensureLoaded, []);
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => watchStateOf(accountId, commitmentId),
  );
}

/** Tests only. */
export function resetWatchStatusForTests(): void {
  status = null;
  published = false;
  loading = null;
}

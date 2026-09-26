/**
 * The saved places, shared between "My places", the reminder editor and the
 * mount that arms the regions (closure CL4).
 *
 * One in-memory copy per account over `lib/deviceSettings/placeReminders.ts`,
 * with listeners, so saving Home on one screen re-arms the reminders that name
 * it without a second read of storage.
 */
import { useEffect, useSyncExternalStore } from 'react';
import * as Crypto from 'expo-crypto';
import { loadPlaces, savePlaces, type Place, type PlaceKind } from '../../lib/deviceSettings/placeReminders';
import { currentPosition, getLocationAccess, requestForegroundAccess, type LocationAccess } from './nativeLocation';

interface Snapshot { readonly loaded: boolean; readonly places: readonly Place[] }
const EMPTY: Snapshot = Object.freeze({ loaded: false, places: Object.freeze([]) as readonly Place[] });

const snapshots = new Map<string, Snapshot>();
const listeners = new Set<() => void>();
const loading = new Map<string, Promise<void>>();

function publish(accountId: string, places: readonly Place[]): void {
  snapshots.set(accountId, { loaded: true, places });
  for (const listener of [...listeners]) listener();
}

export function ensurePlacesLoaded(accountId: string): Promise<void> {
  if (snapshots.get(accountId)?.loaded) return Promise.resolve();
  const pending = loading.get(accountId);
  if (pending) return pending;
  const next = loadPlaces(accountId).then(places => {
    loading.delete(accountId);
    if (!snapshots.get(accountId)?.loaded) publish(accountId, places);
  });
  loading.set(accountId, next);
  return next;
}

export function placesSnapshot(accountId: string | null): Snapshot {
  return accountId ? snapshots.get(accountId) ?? EMPTY : EMPTY;
}

export function usePlaces(accountId: string | null): Snapshot {
  useEffect(() => {
    if (accountId) void ensurePlacesLoaded(accountId);
  }, [accountId]);
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => placesSnapshot(accountId),
  );
}

/** The fixed ids of the two named places, so both of a person's phones mean the same Home. */
export const HOME_ID = 'place_home';
export const WORK_ID = 'place_work';

export function newPlaceId(): string {
  return `place_${Crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export type PinResult =
  | { readonly ok: true; readonly place: Place }
  | { readonly ok: false; readonly reason: 'denied' | 'unavailable' | 'position' };

/**
 * Saves (or moves) a place to where the phone is now. This is the moment
 * "While Using" is asked for: the person just asked for their location to be
 * used.
 */
export async function pinPlaceHere(
  accountId: string,
  input: { id: string; kind: PlaceKind; label: string },
  now: () => Date = () => new Date(),
): Promise<PinResult> {
  const access: LocationAccess = await requestForegroundAccess();
  // Whatever was answered, every screen drawing the access state hears it.
  await refreshLocationAccess();
  // Still undetermined after asking is an answer that was not yes.
  if (access === 'denied' || access === 'undetermined') return { ok: false, reason: 'denied' };
  if (access === 'unavailable') return { ok: false, reason: 'unavailable' };
  const position = await currentPosition();
  if (!position) return { ok: false, reason: 'position' };
  await ensurePlacesLoaded(accountId);
  const place: Place = {
    id: input.id,
    kind: input.kind,
    label: input.label.trim(),
    latitude: position.latitude,
    longitude: position.longitude,
    updatedAt: now().toISOString(),
  };
  const next = [...placesSnapshot(accountId).places.filter(existing => existing.id !== place.id), place];
  await savePlaces(accountId, next);
  publish(accountId, next);
  return { ok: true, place };
}

export async function removePlace(accountId: string, id: string): Promise<void> {
  await ensurePlacesLoaded(accountId);
  const next = placesSnapshot(accountId).places.filter(place => place.id !== id);
  await savePlaces(accountId, next);
  publish(accountId, next);
}

/** After sign-out: nothing of the last account is left in memory. */
export function forgetPlaces(accountId: string): void {
  snapshots.delete(accountId);
  loading.delete(accountId);
  for (const listener of [...listeners]) listener();
}

// ── Location access, as the screens draw it ─────────────────────

/** `checking` until the first answer, so nothing is drawn as paused while the phone is still being asked. */
export type AccessState = LocationAccess | 'checking';
let access: AccessState = 'checking';
const accessListeners = new Set<() => void>();

export async function refreshLocationAccess(): Promise<LocationAccess> {
  const next = await getLocationAccess();
  if (next !== access) {
    access = next;
    for (const listener of [...accessListeners]) listener();
  }
  return next;
}

export function useLocationAccess(): AccessState {
  useEffect(() => {
    void refreshLocationAccess();
  }, []);
  return useSyncExternalStore(
    listener => {
      accessListeners.add(listener);
      return () => accessListeners.delete(listener);
    },
    () => access,
  );
}

/** Tests only. */
export function resetPlacesStoreForTests(): void {
  snapshots.clear();
  loading.clear();
  access = 'checking';
}

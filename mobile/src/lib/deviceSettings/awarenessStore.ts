/**
 * "I know about this" — remembered across a relaunch (UC-3.11, #196).
 *
 * ── The defect this exists to fix ────────────────────────────────
 *
 * The Flutter engine kept awareness in memory (`InMemoryAwarenessStateStore`,
 * `archive/flutter-final`, `lib/services/providers.dart:208-210`), so a user
 * who tapped a soft reminder to say they knew, and then force-quit the app, was
 * reminded again thirty minutes later by the follow-up. The one gesture whose
 * entire meaning is "stop" survived exactly as long as the process did.
 *
 * ── Why this may live in `src/lib/deviceSettings` ────────────────
 *
 * This directory's README asks every addition to make its own argument. Here
 * it is. What is stored is a **commitment id and two instants** — no title, no
 * description, no time of day, nothing about what the commitment is. It is a
 * fact about this installation's notification state, not a copy of the user's
 * week; a second device schedules its own reminders and answers for itself.
 * It has to survive a relaunch — that *is* the feature — and it is cleared on
 * sign-out with the routine cache. There is nothing in a row here that would
 * mean anything to somebody who read it off the device.
 *
 * ── Keyed by account, like the routine cache ─────────────────────
 *
 * The 2026-09-14 audit found four accounts sharing one routine cache on one
 * device (#148). A shared awareness store would be the same mistake with a
 * quieter symptom: B taps a reminder, and A's follow-up for a commitment with
 * a colliding id stops arriving.
 *
 * ── The start is fingerprinted ───────────────────────────────────
 *
 * Awareness is about a commitment *at a time*. Moving a commitment to tomorrow
 * starts a fresh cycle, because the thing the user acknowledged is not the
 * thing that is now going to happen. That is the whole of `isAware`'s second
 * argument.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_AWARENESS,
  parseAwarenessCache,
  pruneAwareness,
  withAwareness,
  type AwarenessCache,
} from './awareness';

// The pure half lives in `awareness.ts` so the reminder planner can load
// without this file's native import; everything it exports is still here.
export {
  AWARENESS_CACHE_VERSION,
  AWARENESS_MAX_AGE_MS,
  EMPTY_AWARENESS,
  isAware,
  parseAwarenessCache,
  pruneAwareness,
  withAwareness,
  type AwarenessCache,
  type AwarenessEntry,
} from './awareness';

export function awarenessStorageKey(accountId: string): string {
  return `awareness.v1.${accountId}`;
}

export async function loadAwareness(accountId: string): Promise<AwarenessCache> {
  try {
    return parseAwarenessCache(await AsyncStorage.getItem(awarenessStorageKey(accountId)));
  } catch {
    return EMPTY_AWARENESS;
  }
}

/** Returns false when the write did not land, so a caller can say so. */
export async function saveAwareness(accountId: string, cache: AwarenessCache): Promise<boolean> {
  try {
    await AsyncStorage.setItem(awarenessStorageKey(accountId), JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

/**
 * Records that the user knows, pruning on the way through.
 *
 * Pruning happens here rather than on a timer because this is the only moment
 * the file is written anyway, and a prune nobody triggers is a prune that never
 * runs.
 */
export async function markAware(
  accountId: string,
  commitmentId: string,
  scheduledStart: string | null,
  now: Date,
): Promise<AwarenessCache> {
  const pruned = pruneAwareness(await loadAwareness(accountId), now.getTime());
  const next = withAwareness(pruned, commitmentId, scheduledStart, now.toISOString());
  await saveAwareness(accountId, next);
  return next;
}

export async function clearAwareness(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(awarenessStorageKey(accountId));
  } catch {
    // The caller is signing out, and an unremovable cache is not a reason to
    // keep them signed in.
  }
}

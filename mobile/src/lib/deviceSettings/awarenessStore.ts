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

export const AWARENESS_CACHE_VERSION = 1;

/** Entries older than this are forgotten; the commitments are long gone. */
export const AWARENESS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function awarenessStorageKey(accountId: string): string {
  return `awareness.v1.${accountId}`;
}

export interface AwarenessEntry {
  /** When the user said they knew. ISO-8601. */
  readonly at: string;
  /** The commitment's scheduled start when they said it. ISO-8601. */
  readonly startFingerprint: string;
}

export interface AwarenessCache {
  readonly version: number;
  readonly entries: Readonly<Record<string, AwarenessEntry>>;
}

export const EMPTY_AWARENESS: AwarenessCache = Object.freeze({
  version: AWARENESS_CACHE_VERSION,
  entries: Object.freeze({}),
});

/**
 * A stored blob, if this version understands it.
 *
 * A cache written by a future version reads as empty rather than as a partial
 * one. The failure direction matters: a half-read cache would silence a
 * reminder the user never acknowledged, which is the quiet failure. An empty
 * one reminds somebody about something they already know about, which they can
 * see and act on.
 */
export function parseAwarenessCache(raw: string | null): AwarenessCache {
  if (!raw) return EMPTY_AWARENESS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return EMPTY_AWARENESS;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_AWARENESS;
  const cache = value as Record<string, unknown>;
  if (cache.version !== AWARENESS_CACHE_VERSION) return EMPTY_AWARENESS;
  const stored = cache.entries;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return EMPTY_AWARENESS;

  const entries: Record<string, AwarenessEntry> = {};
  for (const [id, entry] of Object.entries(stored as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.at !== 'string' || typeof row.startFingerprint !== 'string') continue;
    entries[id] = { at: row.at, startFingerprint: row.startFingerprint };
  }
  return { version: AWARENESS_CACHE_VERSION, entries };
}

/** Drops entries older than `AWARENESS_MAX_AGE_MS`. Pure. */
export function pruneAwareness(cache: AwarenessCache, now: number): AwarenessCache {
  const entries: Record<string, AwarenessEntry> = {};
  for (const [id, entry] of Object.entries(cache.entries)) {
    const at = Date.parse(entry.at);
    if (!Number.isNaN(at) && now - at <= AWARENESS_MAX_AGE_MS) entries[id] = entry;
  }
  return { version: AWARENESS_CACHE_VERSION, entries };
}

/**
 * Whether the user has said they know about this commitment *as it now stands*.
 *
 * False when the start has moved: a rescheduled commitment gets a fresh cycle,
 * which is #196's third acceptance criterion.
 */
export function isAware(
  cache: AwarenessCache,
  commitmentId: string,
  scheduledStart: string | null,
): boolean {
  const entry = cache.entries[commitmentId];
  if (!entry) return false;
  return entry.startFingerprint === (scheduledStart ?? '');
}

export function withAwareness(
  cache: AwarenessCache,
  commitmentId: string,
  scheduledStart: string | null,
  at: string,
): AwarenessCache {
  return {
    version: AWARENESS_CACHE_VERSION,
    entries: { ...cache.entries, [commitmentId]: { at, startFingerprint: scheduledStart ?? '' } },
  };
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

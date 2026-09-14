/**
 * The routine survey's offline copy (UC-2.R1 #171, UC-2.7a #167).
 *
 * ── One copy per account, not per device (#148) ──────────────────
 *
 * This used to be a single key for the whole installation. `src/api` has
 * scoped its query keys by uid since #148 for exactly this reason, and the
 * disk copy did not follow: on the 2026-09-14 audit four accounts shared one
 * device, and every one of them opened the survey pre-filled with somebody
 * else's answers. Sleep and focus hours are personal, so every read and write
 * here names the account it is for, and no caller can forget to.
 *
 * ── Why there is a local copy at all ─────────────────────────────
 *
 * The account is the source of truth: the server plans the day from the
 * profile, and #167 syncs it there. This copy exists so the survey works on a
 * plane. Somebody answering five questions in a tunnel must not lose them, and
 * must not be shown a spinner for a screen that needs no network.
 *
 * ── What `pendingSync` is, and what it is not ────────────────────
 *
 * It is a single bit meaning "the copy on this device is newer than the last
 * one the server acknowledged". When the app comes back online it re-sends the
 * **current** profile, once.
 *
 * It is deliberately *not* a queue. UC-1.R4 (#157) forbids replaying stored
 * mutations, and rightly: a queue of three survey saves would re-apply two
 * answers the user has already changed their mind about. Re-sending the latest
 * state is idempotent — the server's `PUT` takes the whole profile — so one bit
 * is both sufficient and the only thing that cannot go stale.
 *
 * ── Failure is never fatal ───────────────────────────────────────
 *
 * Every storage call is wrapped. A device with no writable storage still gets
 * a working survey for this session; it just cannot remember it. Losing the
 * cache is a degradation, and blocking the app on it would be a defect.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { EMPTY_ANSWERS, type RoutineAnswers } from '../../features/routine/routineProfile';

/**
 * The key an earlier build used for everybody.
 *
 * Exported so the purge below can be asserted, and kept only to be deleted:
 * an installation that has been through the leak is still holding one
 * account's answers under it.
 */
export const LEGACY_SHARED_STORAGE_KEY = 'routine.profile.v1';

/** Where one account's answers live on this device. */
export function routineStorageKey(accountId: string): string {
  return `routine.profile.v1.${accountId}`;
}

export const ROUTINE_CACHE_VERSION = 1;

export interface RoutineCache {
  version: number;
  answers: RoutineAnswers;
  /** Whether the user reached the survey and chose not to answer it. */
  skipped: boolean;
  /** ISO instant of the last local write. Compared with the server's copy. */
  updatedAt: string;
  /** The local copy is ahead of what the server has acknowledged. */
  pendingSync: boolean;
  /** The zone the answers were given in; sent with them. */
  timezone: string;
}

export const EMPTY_CACHE: RoutineCache = {
  version: ROUTINE_CACHE_VERSION,
  answers: EMPTY_ANSWERS,
  skipped: false,
  updatedAt: '',
  pendingSync: false,
  timezone: 'UTC',
};

const CHOICE_KEYS: readonly (keyof RoutineAnswers)[] = ['sleep', 'focus', 'fixed', 'reminder', 'quiet'];

/**
 * A stored blob, if it is one this version understands.
 *
 * A cache written by a future version reads as absent rather than as a partial
 * profile: half-restored answers would show the user chips they never picked.
 */
export function parseRoutineCache(raw: string | null): RoutineCache | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cache = value as Record<string, unknown>;
  if (cache.version !== ROUTINE_CACHE_VERSION) return null;
  const answers = cache.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return null;

  const restored = { ...EMPTY_ANSWERS } as Record<string, unknown>;
  for (const key of CHOICE_KEYS) {
    const stored = (answers as Record<string, unknown>)[key];
    restored[key] = typeof stored === 'string' ? stored : null;
  }

  return {
    version: ROUTINE_CACHE_VERSION,
    answers: restored as unknown as RoutineAnswers,
    skipped: cache.skipped === true,
    updatedAt: typeof cache.updatedAt === 'string' ? cache.updatedAt : '',
    pendingSync: cache.pendingSync === true,
    timezone: typeof cache.timezone === 'string' && cache.timezone ? cache.timezone : 'UTC',
  };
}

export async function loadRoutineCache(accountId: string): Promise<RoutineCache | null> {
  try {
    // Whoever's answers these were, they are not this account's, and an
    // upgrade is the last moment anybody can be sure of that. Deleted rather
    // than adopted: guessing an owner is how the leak would survive the fix.
    await AsyncStorage.removeItem(LEGACY_SHARED_STORAGE_KEY);
    return parseRoutineCache(await AsyncStorage.getItem(routineStorageKey(accountId)));
  } catch {
    return null;
  }
}

/** Returns false when the write did not land, so a caller can say so. */
export async function saveRoutineCache(accountId: string, cache: RoutineCache): Promise<boolean> {
  try {
    await AsyncStorage.setItem(routineStorageKey(accountId), JSON.stringify(cache));
    return true;
  } catch {
    return false;
  }
}

export async function clearRoutineCache(accountId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(routineStorageKey(accountId));
  } catch {
    // Nothing to do: the caller is signing out, and an unremovable cache is
    // not a reason to keep them signed in.
  }
}

/**
 * Which copy wins when the device and the server disagree.
 *
 * The server wins on ties and whenever its copy is at least as new, because a
 * tie means both were written in the same millisecond by the same save. A
 * device only wins while it holds something the server has never seen — which
 * is exactly what `pendingSync` marks.
 */
export function serverCopyWins(local: RoutineCache | null, serverUpdatedAt: string | null): boolean {
  if (!serverUpdatedAt) return false;
  if (!local || !local.updatedAt) return true;
  if (local.pendingSync) return false;
  return Date.parse(serverUpdatedAt) >= Date.parse(local.updatedAt);
}

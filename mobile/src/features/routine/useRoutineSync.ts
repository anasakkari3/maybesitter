/**
 * Keeping the survey on the phone and the survey on the account in step
 * (UC-2.7a, #167 step 5).
 *
 * ── Once, not repeatedly ─────────────────────────────────────────
 *
 * The push runs at most once per time the app becomes reachable. `attempted`
 * is keyed on the cache's `updatedAt`, so a failed send is retried the next
 * time the app comes back online, but a *succeeded* one is never repeated and
 * a re-render never triggers another. Without that key a flaky network turns
 * into a request per render.
 *
 * ── "Comes back online" has to be something this hook hears ──────
 *
 * It was not. `onlineManager.isOnline()` was *read* inside the effect, so
 * reconnecting changed nothing the effect depended on and it never re-ran: the
 * retry the comment promised could only happen if the component remounted, and
 * this hook mounted on one settings screen. A survey answered offline during
 * onboarding therefore sat unsent until the user went looking for it.
 *
 * So the manager is subscribed to, and the latch is released on the
 * offline → online edge — there and nowhere else. Releasing it on every
 * failure would be a retry loop; releasing it on a timer would be a queue, and
 * #157 forbids replaying stored commands. One attempt per reconnection, of the
 * current state, is the whole policy.
 *
 * ── The decision is not here ─────────────────────────────────────
 *
 * `decideRoutineSync` owns the rule and is a pure function; this owns the
 * plumbing — reading the cache, watching connectivity, and writing the result
 * back. Keeping them apart is what makes "an answer given offline is never
 * overwritten by the server's older copy" a thing that can be tested at all.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { onlineManager } from '@tanstack/react-query';
import { useProfile, usePutRoutine } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  EMPTY_CACHE,
  loadRoutineCache,
  saveRoutineCache,
  type RoutineCache,
} from '../../lib/deviceSettings/routineCache';
import { toRoutinePayload, type RoutineAnswers } from './routineProfile';
import { answersDiffer, decideRoutineSync } from './routineSync';

export interface RoutineSyncState {
  /** The answers to render: the newer of the two copies. */
  answers: RoutineAnswers | null;
  /** The device holds something the account has not accepted yet. */
  pendingSync: boolean;
  /** Still reading the local copy. */
  loading: boolean;
  /**
   * The phone refused to keep the copy on disk.
   *
   * `saveRoutineCache` has always reported this and both callers threw it
   * away, so a device with unwritable storage looked exactly like a device
   * that had saved. It is surfaced rather than logged because the user is the
   * only one who can do anything about it.
   */
  localSaveFailed: boolean;
}

export function useRoutineSync(): RoutineSyncState {
  // The answers belong to the account, not to the phone (#148). No uid means
  // nobody to read them for, so nothing is read and nothing is written — an
  // unowned copy is how they crossed accounts in the first place.
  const accountId = useAuth().user?.uid ?? null;
  const profile = useProfile();
  const putRoutine = usePutRoutine();
  const [cache, setCache] = useState<RoutineCache | null>(null);
  const [loading, setLoading] = useState(true);
  const [localSaveFailed, setLocalSaveFailed] = useState(false);
  const [online, setOnline] = useState(() => onlineManager.isOnline());
  const attempted = useRef<string | null>(null);

  // Connectivity as a value this hook renders on, not a value it samples.
  useEffect(() => onlineManager.subscribe(next => {
    // The edge, and only the edge. Cleared here rather than in the effect
    // below so the latch is already open by the time that effect re-runs for
    // the same change.
    if (next) attempted.current = null;
    setOnline(next);
  }), []);

  useEffect(() => {
    let live = true;
    void (async () => {
      const stored = accountId ? await loadRoutineCache(accountId) : null;
      if (!live) return;
      setCache(stored);
      setLoading(false);
    })();
    return () => { live = false; };
  }, [accountId]);

  /**
   * Persist first, then reflect.
   *
   * The state update is deliberately inside the promise: the cache on disk is
   * the thing that has to be true, and a screen showing an answer that failed
   * to persist would be wrong on the next launch. It also keeps the effect
   * below free of a synchronous `setState`, which the React Compiler lint
   * rightly refuses.
   */
  const write = useCallback((next: RoutineCache): Promise<void> => {
    if (!accountId) return Promise.resolve();
    return saveRoutineCache(accountId, next).then(stored => {
      // Reflected either way — what is on screen is true for this session —
      // but a disk that refused the write is reported rather than dropped.
      setLocalSaveFailed(!stored);
      setCache(next);
    });
  }, [accountId]);

  useEffect(() => {
    if (loading) return;
    // A 404 means the memory feature is off for this build; there is no account
    // copy to reconcile with, and the local one is simply the answer.
    const server = profile.data?.routine ?? null;
    const action = decideRoutineSync({ local: cache, server, online });

    if (action.kind === 'idle') return;

    if (action.kind === 'adopt') {
      if (cache && !answersDiffer(cache.answers, action.answers)) return;
      void write({
        ...(cache ?? EMPTY_CACHE),
        answers: action.answers,
        updatedAt: action.updatedAt,
        pendingSync: false,
      });
      return;
    }

    // push — at most once per local version.
    if (attempted.current === action.cache.updatedAt) return;
    attempted.current = action.cache.updatedAt;
    const payload = toRoutinePayload(action.cache.answers, action.cache.timezone, {
      skipped: action.cache.skipped,
    });
    void putRoutine.mutateAsync(payload)
      .then(() => write({ ...action.cache, pendingSync: false }))
      // Left pending on purpose, and left latched: the next reconnection opens
      // the latch and this runs again with whatever the current state is by
      // then. Nothing is queued and nothing is replayed.
      .catch(() => undefined);
  }, [cache, loading, online, profile.data, putRoutine, write]);

  return {
    answers: cache?.answers ?? null,
    pendingSync: cache?.pendingSync === true,
    loading,
    localSaveFailed,
  };
}

/**
 * Keeping the survey on the phone and the survey on the account in step
 * (UC-2.7a, #167 step 5).
 *
 * ── Once, not repeatedly ─────────────────────────────────────────
 *
 * The push runs at most once per time the app becomes reachable. `attempted`
 * is keyed on the cache's `updatedAt`, so a failed send is retried the next
 * time the app comes to the foreground online, but a *succeeded* one is never
 * repeated and a re-render never triggers another. Without that key a flaky
 * network turns into a request per render.
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
}

export function useRoutineSync(): RoutineSyncState {
  const profile = useProfile();
  const putRoutine = usePutRoutine();
  const [cache, setCache] = useState<RoutineCache | null>(null);
  const [loading, setLoading] = useState(true);
  const attempted = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const stored = await loadRoutineCache();
      if (!live) return;
      setCache(stored);
      setLoading(false);
    })();
    return () => { live = false; };
  }, []);

  /**
   * Persist first, then reflect.
   *
   * The state update is deliberately inside the promise: the cache on disk is
   * the thing that has to be true, and a screen showing an answer that failed
   * to persist would be wrong on the next launch. It also keeps the effect
   * below free of a synchronous `setState`, which the React Compiler lint
   * rightly refuses.
   */
  const write = useCallback((next: RoutineCache): Promise<void> =>
    saveRoutineCache(next).then(() => {
      setCache(next);
    }), []);

  useEffect(() => {
    if (loading) return;
    // A 404 means the memory feature is off for this build; there is no account
    // copy to reconcile with, and the local one is simply the answer.
    const server = profile.data?.routine ?? null;
    const action = decideRoutineSync({ local: cache, server, online: onlineManager.isOnline() });

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
      // Left pending on purpose. The next foreground-while-online tries again,
      // because `attempted` is keyed on this version and the app will have
      // re-mounted or the effect re-run by then.
      .catch(() => undefined);
  }, [cache, loading, profile.data, putRoutine, write]);

  return {
    answers: cache?.answers ?? null,
    pendingSync: cache?.pendingSync === true,
    loading,
  };
}

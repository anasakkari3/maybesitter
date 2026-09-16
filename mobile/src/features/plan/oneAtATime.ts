import { useCallback, useRef } from 'react';

/**
 * One tap, one request (UC-3.10b, #195).
 *
 * ── Why `disabled={mutation.isPending}` is not enough ────────────
 *
 * `isPending` is React state. It becomes true when the mutation starts, but the
 * button that reads it is only *re-rendered* afterwards — so three presses
 * dispatched before React commits that render all see the old `disabled` and
 * all fire. `ServerToggle` has the same shape of guard and the same hole; it
 * survives because a `Switch` cannot realistically be flipped three times in
 * one frame, and a button can: a double tap on a slow phone is an ordinary
 * thing for a person to do.
 *
 * This ran green under parallel Jest workers and red under `--runInBand`, on
 * the acceptance criterion "'Looks good' sends exactly one accept". Timing
 * decided whether the guard held, which means it was not a guard.
 *
 * A ref is written synchronously, inside the press handler, before React is
 * asked to do anything. So the second press sees the first one's mark.
 *
 * ── What it costs, and why it is spent on all three ──────────────
 *
 * Accept is the criterion, but a repeated **rebuild** is the expensive one: each
 * one is a model call and burns one of the day's four generations. And a
 * repeated **edit** would send two optimistic updates whose rollbacks restore
 * each other's intermediate state. All three go through this.
 */
export interface OneAtATime {
  /** True when the caller may proceed; false when something is still in flight. */
  enter: () => boolean;
  /** Called when that work settles, whether it succeeded or not. */
  leave: () => void;
}

export function useOneAtATime(): OneAtATime {
  const busy = useRef(false);
  const enter = useCallback(() => {
    if (busy.current) return false;
    busy.current = true;
    return true;
  }, []);
  const leave = useCallback(() => { busy.current = false; }, []);
  return { enter, leave };
}

/**
 * The undo window (CA11.2, CX3.1; owner decision 2026-11-19).
 *
 * An action offered with «رجّعها» is held here for the toast's few seconds and
 * only then sent. «رجّعها» cancels it before anything reaches the server, so
 * there is no server-side reversal to make safe: no new transition, no second
 * write to race, and the account isolation and replay guards of the route the
 * action finally calls are the ones that already hold.
 *
 * Bounded both ways. The window is the toast's own length, and when the app
 * goes to the background everything pending is sent at once, so a person who
 * closes the app right after the tap does not lose what they chose. Only
 * `background`: iOS is `inactive` under the notification centre or a call,
 * and sending then would take «رجّعها» away while the toast is still up.
 *
 * Module state on purpose: the screen that started an action is often gone
 * before the window closes (Details goes back as soon as Done is pressed).
 */
import { AppState, type NativeEventSubscription } from 'react-native';

/** Five seconds, the toast's `TOAST_SECONDS`; a test binds the two together. */
export const UNDO_WINDOW_MS = 5_000;

interface Pending {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly commit: () => void;
}

const pending = new Map<number, Pending>();
let nextId = 0;
let subscription: NativeEventSubscription | null = null;

function settle(id: number): Pending | null {
  const entry = pending.get(id);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pending.delete(id);
  if (pending.size === 0 && subscription) {
    subscription.remove();
    subscription = null;
  }
  return entry;
}

/**
 * Holds `commit` for the window, then runs it once. Returns the undo: true
 * when it took the action back, false when there was nothing left to take
 * back (already sent, or already undone).
 */
export function deferWithUndo(commit: () => void, ms: number = UNDO_WINDOW_MS): () => boolean {
  nextId += 1;
  const id = nextId;
  const timer = setTimeout(() => { settle(id)?.commit(); }, ms);
  pending.set(id, { timer, commit });
  if (!subscription) {
    subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') void flushPendingCommits();
    });
  }
  return () => settle(id) !== null;
}

/** Sends everything still held, now. */
export function flushPendingCommits(): void {
  for (const id of [...pending.keys()]) settle(id)?.commit();
}

export function pendingCommitCount(): number {
  return pending.size;
}

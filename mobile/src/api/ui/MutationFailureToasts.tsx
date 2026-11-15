import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApp } from '../../state/AppContext';
import { NetworkError, TimeoutError } from '../errors';
import { errorWasShown, markErrorShown, userFacingMessage } from './userFacingMessage';

/**
 * Says a press that failed for want of a connection when nothing else did
 * (review of lane A3).
 *
 * Mutations run with `networkMode: 'always'` (`queryClient.ts`): a press with
 * no signal is tried now and fails now, rather than being held and sent later
 * without the person (CX3.5, CXX3.1). That is only half a fix if the failure
 * is then never read — several surfaces called `mutate` with no `onError`, and
 * a press there did nothing at all, silently.
 *
 * So this watches the mutation cache. A network-class failure (no signal, or
 * no answer in time) that no screen has put into words within a moment is
 * said once, as a toast — the polite live region every platform announces.
 * A screen that says it itself does so through `userFacingMessage`, which
 * marks the error, so it is never said twice. A write the person did not
 * press (analytics, readiness, background sync) opts out with
 * `meta: { quietFailure: true }`.
 *
 * Only network-class failures: a refusal (a 4xx) is the screen's to word, and
 * the screens that refuse already do, in their own terms.
 *
 * ── Why a delay, and its one weakness ────────────────────────────
 *
 * The deterministic signal is the mark: every helper that turns an error into
 * words (`userFacingMessageKey`, `toggleFailureKey`, the plan and weekly
 * helpers…) marks it, and a surface that says a failure in a line it renders
 * later marks it in its own `onError` (the edit, drop/delete and postpone
 * sheets, the next-step card). TanStack runs a `mutate` call's callbacks before
 * it notifies the cache, so those marks are already there when this sees the
 * failure. The delay is for the rest: a `mutateAsync` caught in a promise
 * continuation, or a screen that only words `mutation.error` while rendering.
 * A screen of that last kind whose render lands later than the delay would be
 * said twice — the trade-off kept here rather than silence. New surfaces should
 * mark in `onError`.
 */
export const UNHANDLED_FAILURE_DELAY_MS = 400;

export function MutationFailureToasts(): null {
  const client = useQueryClient();
  const { t, actions } = useApp();
  // Read when the toast is due, so a re-render never drops a pending one.
  const say = useRef((message: string) => actions.toast(message));
  const strings = useRef(t);
  useEffect(() => { say.current = (message: string) => actions.toast(message); strings.current = t; });

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const unsubscribe = client.getMutationCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'error') return;
      const error = event.action.error;
      if (!(error instanceof NetworkError || error instanceof TimeoutError)) return;
      if ((event.mutation.meta as { quietFailure?: boolean } | undefined)?.quietFailure === true) return;
      // A moment for the screen's own handler and render to say it first.
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (errorWasShown(error)) return;
        markErrorShown(error);
        say.current(userFacingMessage(error, strings.current));
      }, UNHANDLED_FAILURE_DELAY_MS);
      timers.add(timer);
    });
    return () => {
      unsubscribe();
      timers.forEach(clearTimeout);
    };
  }, [client]);

  return null;
}

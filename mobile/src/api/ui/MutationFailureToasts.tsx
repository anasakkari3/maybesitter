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

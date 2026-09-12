import { useCallback, useRef, useState } from 'react';

/**
 * Runs an async action, and refuses a second call while the first is in
 * flight.
 *
 * A `busy` boolean in state cannot do this. Two taps that land in the same
 * frame both read the pre-update value, so both pass `if (busy) return` — and
 * on the Google button that meant two account choosers, and on the email form
 * two sign-up attempts for one tap. The guard has to be a ref, which updates
 * synchronously; the state is only there to render the disabled look.
 *
 * A test caught this, which is why it is a shared hook rather than a fix in
 * one screen.
 */
export function useSingleFlight(): {
  busy: boolean;
  run: (action: () => Promise<void>) => Promise<void>;
} {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  return { busy, run };
}

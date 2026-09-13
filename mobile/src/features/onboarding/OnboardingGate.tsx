import React, { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../../auth/AuthProvider';
import { AuthGate } from '../../auth/AuthGate';
import { OnboardingFlow } from './OnboardingFlow';
import { clearOnboardingProgress, loadOnboardingProgress } from '../../lib/deviceSettings/onboardingProgress';

/**
 * The invariant UC-1.7 (#151) protects, extended by UC-2.R1 (#171): a signed-in
 * user who has not finished onboarding cannot reach the product.
 *
 * `AuthGate` already had the slot for this and rendered nothing in it. This
 * fills it, and owns the one piece of state the gate cannot: whether *this
 * install* has been through the screens.
 *
 * ── Why it is read once, not watched ─────────────────────────────
 *
 * The stored step is read on mount and when the uid changes. It is not polled
 * and there is no listener: the only thing that finishes onboarding is
 * `OnboardingFlow` telling this component it did, which it does in the same
 * tick it writes the value. A watcher would be a second source of truth for a
 * fact that already has one.
 *
 * ── Signing out clears it ────────────────────────────────────────
 *
 * A shared phone must not hand the next person somebody else's finished state,
 * and more importantly must not skip the consent screen for them: they have
 * agreed to nothing.
 */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const uid = user?.uid ?? null;
  const [complete, setComplete] = useState<boolean | null>(null);

  // Adjusted during render, not in an effect: the lint refuses a synchronous
  // `setState` inside one, and this is exactly the case React documents it for
  // — state that has to change because another value did.
  const [statusSeen, setStatusSeen] = useState(status);
  if (statusSeen !== status) {
    setStatusSeen(status);
    if (status === 'signedOut') setComplete(null);
  }

  useEffect(() => {
    // `loading` is not `signedOut`. Firebase answers a frame or two after
    // mount, and clearing here would wipe a returning user's finished state on
    // every single launch — sending somebody who onboarded months ago back to
    // the welcome screen. Only an actual sign-out forgets.
    if (status === 'loading') return;
    if (status === 'signedOut') {
      // A shared phone must not hand the next person a finished state, and
      // must not skip the consent screen for someone who has agreed to nothing.
      void clearOnboardingProgress();
      return;
    }
    let live = true;
    void (async () => {
      const progress = await loadOnboardingProgress();
      if (live) setComplete(progress === 'done');
    })();
    return () => { live = false; };
  }, [status, uid]);

  const onFinished = useCallback(() => setComplete(true), []);

  return (
    <AuthGate
      // `null` — still reading — counts as incomplete. Erring the other way
      // would flash the product at somebody who has not consented to anything.
      onboardingComplete={complete === true}
      onboarding={<OnboardingFlow onFinished={onFinished} />}
    >
      {children}
    </AuthGate>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useAuth } from '../../auth/AuthProvider';
import { AuthGate } from '../../auth/AuthGate';
import { useConsents } from '../../api/queries';
import { useApp } from '../../state/AppContext';
import { OnboardingFlow } from './OnboardingFlow';
import { RoutineSyncMount } from '../routine/RoutineSyncMount';
import {
  clearOnboardingProgress,
  loadOnboardingProgress,
  resolveOnboardingGate,
  saveOnboardingProgress,
  type AccountOnboardingSignal,
  type OnboardingProgress,
} from '../../lib/deviceSettings/onboardingProgress';

/**
 * The invariant UC-1.7 (#151) protects, extended by UC-2.R1 (#171): a signed-in
 * user who has not finished onboarding cannot reach the product.
 *
 * `AuthGate` already had the slot for this and rendered nothing in it. This
 * fills it, from two sources:
 *
 *  - **this install's progress** — the step to resume on, or `done`;
 *  - **the account's answers** — whether the consent screen has ever been
 *    answered, from `GET /api/mobile/consents` (audit 2026-10-03, #5).
 *
 * The device copy alone used to decide, and sign-out clears it, so signing out
 * and back in with the same account replayed every screen, consents included.
 * `resolveOnboardingGate` holds the rule; read it there.
 *
 * ── Why it is read once, not watched ─────────────────────────────
 *
 * The stored step is read on mount and when the uid changes. It is not polled
 * and there is no listener: the only thing that finishes onboarding is
 * `OnboardingFlow` telling this component it did, which it does in the same
 * tick it writes the value. A watcher would be a second source of truth for a
 * fact that already has one.
 *
 * ── Signing out still clears the device copy ─────────────────────
 *
 * A shared phone must not hand the next person somebody else's finished state,
 * and must not skip the consent screen for them: they have agreed to nothing.
 * The next person's *account* answers for them — a brand-new one has answered
 * nothing, and gets every screen.
 */
/** How long the gate holds on the blank view for the account's answer. */
export const HOLD_MS = 3000;

export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { status, user } = useAuth();
  const { p } = useApp();
  const uid = user?.uid ?? null;
  const [device, setDevice] = useState<OnboardingProgress | null>(null);
  const [finishedHere, setFinishedHere] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  const [decision, setDecision] = useState<boolean | null>(null);
  // Asked only when the device has nothing to say: a finished or part-way
  // install never waits on the network to open, and the consent step keeps
  // sole ownership of its own fetch (and of its own failure state).
  const consents = useConsents({ enabled: device === 'welcome' });

  // Adjusted during render, not in an effect: the lint refuses a synchronous
  // `setState` inside one, and this is exactly the case React documents it for
  // — state that has to change because another value did.
  const [seen, setSeen] = useState({ status, uid });
  if (seen.status !== status || seen.uid !== uid) {
    setSeen({ status, uid });
    setDevice(null);
    setFinishedHere(false);
    setFellBack(false);
    setDecision(null);
  }

  useEffect(() => {
    // `loading` is not `signedOut`. Firebase answers a frame or two after
    // mount, and clearing here would wipe a returning user's finished state on
    // every single launch. Only an actual sign-out forgets.
    if (status === 'loading') return;
    if (status === 'signedOut') {
      void clearOnboardingProgress();
      return;
    }
    let live = true;
    void (async () => {
      const progress = await loadOnboardingProgress();
      if (live) setDevice(progress);
    })();
    return () => { live = false; };
  }, [status, uid]);

  // Unreachable is three things: an error, a failed attempt still retrying,
  // and a query TanStack has *paused* because the phone is offline — which
  // is pending with no failure at all, and held the blank view for as long as
  // there was no signal (review of #5).
  const failed = consents.isError || consents.failureCount > 0 || consents.fetchStatus === 'paused';
  // Latched. The first failure is enough to stop holding — the retries that
  // follow can take seconds, and the consent step has its own "can't reach
  // the server" state. It has to stay stopped: the flow's own consent query
  // refetches on mount, a refetch with no data puts the query back to
  // `pending`, and un-latched the gate would hold again, unmount the flow, and
  // loop. An answer that arrives later still wins (below).
  if (failed && !fellBack) setFellBack(true);
  // And a slow server is not worth more than a few seconds of blank screen:
  // past `HOLD_MS` the gate falls back the same way.
  const waiting = device === 'welcome' && !consents.data && !failed && !fellBack;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setFellBack(true), HOLD_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  const account: AccountOnboardingSignal = consents.data
    ? { kind: 'answered', consentAsked: consents.data.recommendations.asked }
    : failed || fellBack
      ? { kind: 'unreachable' }
      : { kind: 'pending' };
  const live = resolveOnboardingGate(device, account);
  // Decided once per sign-in, then held. A brand-new account answers the
  // consent screen *during* onboarding, the write invalidates the consents
  // query, and the refetch says `asked: true` — re-deciding from it would
  // drop the person into the app straight after the consent step, skipping
  // the routine, about-you and reminders screens. The one decision that is
  // not final is the fallback taken while the server was unreachable: an
  // answer that lands afterwards replaces it.
  const provisional = live === false && account.kind === 'unreachable';
  if (decision === null && live !== null && !provisional) setDecision(live);
  const resolved = finishedHere ? true : decision ?? live;

  // The account said "already onboarded": remember it on this install, so the
  // next launch opens straight away instead of waiting on the server.
  const learnedFromAccount = resolved === true && device === 'welcome' && !finishedHere;
  useEffect(() => {
    if (learnedFromAccount) void saveOnboardingProgress('done');
  }, [learnedFromAccount]);

  const onFinished = useCallback(() => setFinishedHere(true), []);

  return (
    <AuthGate
      // `null` — still reading — counts as incomplete. Erring the other way
      // would flash the product at somebody who has not consented to anything.
      onboardingComplete={resolved === true}
      onboarding={resolved === null
        // Held on the plain background while the answer is read, for the same
        // reason AuthGate holds: flashing the welcome screen at somebody who
        // finished onboarding months ago is the defect this state prevents.
        ? <View testID="onboarding-loading" style={{ flex: 1, backgroundColor: p.bg }} />
        : <OnboardingFlow onFinished={onFinished} />}
    >
      {/* Renders nothing. This is the first point in the tree that is both
          signed in and past onboarding, which is exactly the lifetime the
          routine sync should have. */}
      <RoutineSyncMount />
      {children}
    </AuthGate>
  );
}

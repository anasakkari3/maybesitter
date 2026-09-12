import React, { useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { EmailAuthScreen } from '../screens/EmailAuthScreen';
import { SignInScreen } from '../screens/SignInScreen';

/**
 * What the app shows before it knows who you are, and what it shows once it
 * does.
 *
 * ── Why this is not expo-router ──────────────────────────────────
 *
 * UC-1.7 (#151) was written against `app/_layout.tsx` and `Stack.Protected`.
 * The app that exists has no `app/` directory: `App.tsx` renders `src/Root.tsx`,
 * which switches on a screen name in `AppContext`. Introducing expo-router
 * here would rewrite every screen in the approved round-1 design and collide
 * head-on with UC-2.R1–2.R4 (#171–#174), which own that navigation work. The
 * *invariant* the issue protects — nothing but sign-in is reachable while
 * signed out — is what this component enforces, in the navigation the app has.
 *
 * ── Composing with onboarding later ──────────────────────────────
 *
 * UC-2.R1 (#171) owns the onboarding screens. This gate takes them as a slot:
 * when `onboarding` is given and `onboardingComplete` is false, they render
 * instead of the app. Nothing fake is built here to stand in for them — an
 * unconfigured gate simply goes sign-in → app.
 */
export function AuthGate({
  children,
  onboarding,
  onboardingComplete = true,
  appleSlot,
  googleSlot,
  /** The email flow this gate opens; tests use it to start on a given mode. */
  emailScreen: EmailScreen = EmailAuthScreen,
}: {
  children: React.ReactNode;
  onboarding?: React.ReactNode;
  onboardingComplete?: boolean;
  appleSlot?: React.ReactNode;
  googleSlot?: React.ReactNode;
  emailScreen?: typeof EmailAuthScreen;
}) {
  const { status } = useAuth();
  const { p } = useApp();
  const [showEmail, setShowEmail] = useState(false);

  // A sign-out has to land on the provider list, not on whichever sub-screen
  // the session happened to start from: without this, signing out of a session
  // that began with email would show the email form again. Adjusted during
  // render rather than in an effect, which is React's own advice for state
  // that derives from a change in another value — and avoids the extra pass an
  // effect would cost on every sign-in.
  const [statusAtLastReset, setStatusAtLastReset] = useState(status);
  if (statusAtLastReset !== status) {
    setStatusAtLastReset(status);
    if (status === 'signedIn') setShowEmail(false);
  }

  // Held on the plain background, matching the splash, until Firebase has
  // answered. Flashing the sign-in screen at a signed-in user for one frame is
  // the defect this state exists to prevent.
  if (status === 'loading') {
    return <View testID="auth-loading" style={{ flex: 1, backgroundColor: p.bg }} />;
  }

  if (status === 'signedOut') {
    return showEmail ? (
      <EmailScreen onBack={() => setShowEmail(false)} />
    ) : (
      <SignInScreen appleSlot={appleSlot} googleSlot={googleSlot} onEmail={() => setShowEmail(true)} />
    );
  }

  if (onboarding && !onboardingComplete) return <>{onboarding}</>;

  return <>{children}</>;
}

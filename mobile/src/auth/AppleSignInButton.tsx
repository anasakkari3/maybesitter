import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { appleSignInAvailable, AppleSignInCancelled, AppleSignInUnavailable } from './appleSignIn';
import { authErrorKey } from './authErrors';
import { useSingleFlight } from './useSingleFlight';
import { Txt } from '../ui/primitives';
import { ProviderButton } from './ProviderButton';
import { AppleMark } from '../ui/icons';

/**
 * "Continue with Apple", in the design's position above Google.
 *
 * Availability is asynchronous — it depends on the platform, on the OS
 * version, and on whether the owner has finished the Apple Developer portal
 * and Firebase console steps — so the button renders nothing until it knows,
 * rather than appearing and then disappearing.
 *
 * Apple's Human Interface Guidelines fix the look: black on a light page,
 * white on a dark one, the same height as the other provider buttons. The
 * colours are literals rather than theme tokens for the same reason as
 * Google's — the button is Apple's, not the app's.
 */
export function AppleSignInButton() {
  const { t, p } = useApp();
  const { repository } = useAuth();
  const { busy, run } = useSingleFlight();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [errorKey, setErrorKey] = useState<keyof typeof t | null>(null);

  useEffect(() => {
    let active = true;
    void appleSignInAvailable().then(value => {
      if (active) setAvailable(value);
    });
    return () => {
      active = false;
    };
  }, []);

  const press = useCallback(
    () =>
      run(async () => {
        setErrorKey(null);
        try {
          await repository.signInWithApple();
        } catch (error) {
          if (error instanceof AppleSignInCancelled) return;
          if (error instanceof AppleSignInUnavailable) {
            setErrorKey(
              error.kind === 'unsupportedPlatform' ? 'authErrorAppleUnavailable' : 'authErrorGeneric',
            );
            return;
          }
          setErrorKey(authErrorKey(error));
        }
      }),
    [run, repository],
  );

  if (available !== true) return null;

  return (
    <View style={{ gap: 8 }}>
      {/* Apple's white button on the dark scheme, black on the light one
          (ProviderButton): the HIG never puts the black one on a dark page. */}
      <ProviderButton look="apple" label={t.authContinueApple} busy={busy} onPress={() => void press()} mark={fg => <AppleMark size={18} color={fg} />} />
      {errorKey ? <Txt size={13} color={p.acd}>{t[errorKey]}</Txt> : null}
    </View>
  );
}

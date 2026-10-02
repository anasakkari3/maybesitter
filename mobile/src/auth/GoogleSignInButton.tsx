import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { GoogleSignInCancelled, GoogleSignInUnavailable, googleSignInAvailable } from './googleSignIn';
import { authErrorKey } from './authErrors';
import { useSingleFlight } from './useSingleFlight';
import { Txt } from '../ui/primitives';
import { ProviderButton } from './ProviderButton';
import { GoogleG } from '../ui/icons';

/**
 * "Continue with Google".
 *
 * It renders nothing when the build has no Web Client ID: a button that can
 * only fail with `DEVELOPER_ERROR` is worse than no button, and the user has
 * email sign-in either way.
 *
 * The styling follows Google's guidelines — the unmodified "G" mark on
 * Google's own light or dark surface, at the same height as the other
 * provider buttons — rather than the app's coral, which would recolour a mark
 * Google does not allow recolouring.
 */
export function GoogleSignInButton() {
  const { t, p } = useApp();
  const { repository } = useAuth();
  const { busy, run } = useSingleFlight();
  const [errorKey, setErrorKey] = useState<keyof typeof t | null>(null);

  const press = useCallback(
    () =>
      run(async () => {
        setErrorKey(null);
        try {
          await repository.signInWithGoogle();
        } catch (error) {
          // Backing out of the chooser is a decision, not a failure. Showing
          // an error for it would tell the user they did something wrong.
          if (error instanceof GoogleSignInCancelled) return;
          if (error instanceof GoogleSignInUnavailable) {
            setErrorKey(error.kind === 'playServices' ? 'authErrorNoPlayServices' : 'authErrorGeneric');
            return;
          }
          setErrorKey(authErrorKey(error));
        }
      }),
    [run, repository],
  );

  if (!googleSignInAvailable()) return null;

  return (
    <View style={{ gap: 8 }}>
      {/* Google's own dark or light button, by the scheme the screen is in:
          the unmodified "G" on a surface Google publishes (ProviderButton). */}
      <ProviderButton look="google" label={t.authContinueGoogle} busy={busy} onPress={() => void press()} mark={() => <GoogleG size={18} />} />
      {errorKey ? <Txt size={13} color={p.acd}>{t[errorKey]}</Txt> : null}
    </View>
  );
}

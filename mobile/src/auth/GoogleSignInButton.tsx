import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { GoogleSignInCancelled, GoogleSignInUnavailable, googleSignInAvailable } from './googleSignIn';
import { authErrorKey } from './authErrors';
import { useSingleFlight } from './useSingleFlight';
import { Btn, Txt } from '../ui/primitives';
import { GoogleG } from '../ui/icons';

/**
 * "Continue with Google".
 *
 * It renders nothing when the build has no Web Client ID: a button that can
 * only fail with `DEVELOPER_ERROR` is worse than no button, and the user has
 * email sign-in either way.
 *
 * The styling follows Google's guidelines — the unmodified "G" mark, on a
 * white surface, at the same height as the other provider buttons — rather
 * than the app's teal pill, which would recolour a mark Google does not allow
 * recolouring.
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
      <Btn
        label={t.authContinueGoogle}
        disabled={busy}
        onPress={() => void press()}
        style={{
          backgroundColor: '#FFFFFF',
          borderWidth: 1,
          borderColor: p.ln,
          borderRadius: 999,
          minHeight: 48,
          paddingVertical: 14,
          paddingHorizontal: 18,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 10,
          opacity: busy ? 0.5 : 1,
        }}
      >
        <GoogleG size={18} />
        {/* Fixed dark grey, not a theme token: the mark may only appear on
            Google's own approved surface, so the label matches that surface
            rather than the app's dark mode. */}
        <Txt size={16} weight={600} color="#3C4043">{t.authContinueGoogle}</Txt>
      </Btn>
      {errorKey ? <Txt size={13} color={p.wm}>{t[errorKey]}</Txt> : null}
    </View>
  );
}

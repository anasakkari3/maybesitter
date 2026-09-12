import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useApp } from '../state/AppContext';
import { useAuth } from './AuthProvider';
import { appleSignInAvailable, AppleSignInCancelled, AppleSignInUnavailable } from './appleSignIn';
import { authErrorKey } from './authErrors';
import { useSingleFlight } from './useSingleFlight';
import { Btn, Txt } from '../ui/primitives';
import { AppleMark } from '../ui/icons';

/**
 * "Continue with Apple", in the design's position above Google.
 *
 * Availability is asynchronous — it depends on the platform, on the OS
 * version, and on whether the owner has finished the Apple Developer portal
 * and Firebase console steps — so the button renders nothing until it knows,
 * rather than appearing and then disappearing.
 *
 * Apple's Human Interface Guidelines fix the look: black fill, white mark and
 * label, the same height as the other provider buttons. The colours are
 * literals rather than theme tokens for the same reason as Google's — the
 * button is Apple's, not the app's.
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
      <Btn
        label={t.authContinueApple}
        disabled={busy}
        onPress={() => void press()}
        style={{
          backgroundColor: '#000000',
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
        <AppleMark size={18} color="#FFFFFF" />
        <Txt size={16} weight={600} color="#FFFFFF">{t.authContinueApple}</Txt>
      </Btn>
      {errorKey ? <Txt size={13} color={p.wm}>{t[errorKey]}</Txt> : null}
    </View>
  );
}

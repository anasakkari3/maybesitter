import React, { useEffect } from 'react';
import { Platform, View } from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { apiLocale } from './src/i18n/locale';
import { AppProvider } from './src/state/AppContext';
import { ApiProvider } from './src/api/ui/ApiProvider';
import { AccountDeletionProvider } from './src/features/account/AccountDeletionProvider';
import { AccountDeletedGate } from './src/features/account/AccountDeletedGate';
import { OnboardingGate } from './src/features/onboarding/OnboardingGate';
import { AuthProvider } from './src/auth/AuthProvider';
import { Root } from './src/Root';
import { fontMap } from './src/theme/fonts';
import { initialiseCrashReporting } from './src/lib/crash';

export default function App() {
  const [loaded, error] = useFonts(fontMap);

  // Started once, before anything else can fail. Off in development, and it
  // carries the build's own facts and nothing about the person — see
  // src/lib/crash.ts.
  useEffect(() => {
    void initialiseCrashReporting(apiLocale(), Platform.OS);
  }, []);

  // Hold on the plain background until the Arabic and Latin faces are ready,
  // so text never flashes in a fallback font. A font error still renders.
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: '#F5F7F8' }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        {/* Auth sits inside AppProvider so the sign-in screen is themed and
            localised the same way every other screen is. */}
        <AuthProvider>
          {/* Inside AuthProvider: the API layer takes its bearer from the
              repository, and clears every cached row when the uid changes. */}
          <ApiProvider>
            <AccountDeletionProvider>
              {/* Outside AuthGate on purpose: a successful deletion removes
                  the Firebase user, so the gate flips to sign-in in the same
                  frame — and the receipt the user is owed would vanish with
                  it (UC-1.5 #149). */}
              <AccountDeletedGate>
                {/* The sign-in gate, with UC-2.R1 (#171)'s onboarding composed
                    into the slot it has always had. A signed-in user who has
                    not been through the consent screen does not reach Root. */}
                <OnboardingGate>
                  <Root />
                </OnboardingGate>
              </AccountDeletedGate>
            </AccountDeletionProvider>
          </ApiProvider>
        </AuthProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

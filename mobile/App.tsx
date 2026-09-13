import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from './src/state/AppContext';
import { Root } from './src/Root';
import { fontMap } from './src/theme/fonts';

// Keep the branded native launch screen visible until both app fonts are ready.
SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function App() {
  const [loaded, error] = useFonts(fontMap);

  useEffect(() => {
    if (loaded || error) SplashScreen.hide();
  }, [loaded, error]);

  // The native splash remains above this background until the Arabic and Latin
  // faces are ready, so text never flashes in a fallback font. A font error
  // still renders the app.
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: '#F5F7F8' }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <Root />
      </AppProvider>
    </SafeAreaProvider>
  );
}

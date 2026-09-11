import React from 'react';
import { View } from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppProvider } from './src/state/AppContext';
import { Root } from './src/Root';
import { fontMap } from './src/theme/fonts';

export default function App() {
  const [loaded, error] = useFonts(fontMap);

  // Hold on the plain background until the Arabic and Latin faces are ready,
  // so text never flashes in a fallback font. A font error still renders.
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: '#F5F7F8' }} />;

  return (
    <SafeAreaProvider>
      <AppProvider>
        <Root />
      </AppProvider>
    </SafeAreaProvider>
  );
}

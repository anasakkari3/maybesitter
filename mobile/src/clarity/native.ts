import { NativeModules, Platform } from 'react-native';
import Constants from 'expo-constants';

export type ClaritySdk = typeof import('@microsoft/react-native-clarity');

export function clarityAvailable(): boolean {
  return (Platform.OS === 'ios' || Platform.OS === 'android') && Constants.appOwnership !== 'expo'
    && Boolean(NativeModules.Clarity && NativeModules.ClarityEmitter);
}

/** The package constructs a native emitter on import. Never load it in Expo Go. */
export function loadClarity(): ClaritySdk | null {
  if (!clarityAvailable()) return null;
  try {
    // A static import constructs NativeEventEmitter before the Expo Go guard.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@microsoft/react-native-clarity') as ClaritySdk;
  } catch {
    return null;
  }
}

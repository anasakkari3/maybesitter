import type { ConfigContext, ExpoConfig } from 'expo/config';
// The .ts extension is required: Expo transpiles this file to CommonJS and
// requires the import by path, and Node cannot resolve an extensionless
// TypeScript file. `allowImportingTsExtensions` in tsconfig.json permits it.
import { releaseConfigErrorMessage, releaseConfigProblems, type AppEnv } from './src/config/releaseGuard.ts';

// Expo reads this while it loads the project — before any native compile — so a
// staging or production build configured without a real https backend stops in
// seconds instead of reaching a tester. `npx expo config` fails the same way.

const APP_ENV = (process.env.APP_ENV ?? process.env.EXPO_PUBLIC_APP_ENV ?? 'development') as AppEnv;

const problems = releaseConfigProblems({
  appEnv: APP_ENV,
  apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
  devBearerToken: process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN,
});
if (problems.length > 0) throw new Error(releaseConfigErrorMessage(problems));

const NAME_SUFFIX: Record<AppEnv, string> = {
  development: ' (Dev)',
  staging: ' (Staging)',
  production: '',
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `MaybeSitter${NAME_SUFFIX[APP_ENV]}`,
  slug: 'maybesitter',
  scheme: 'maybesitter',
  // One identifier on both platforms and in every profile: the app has never
  // shipped, and one Firebase project needs exactly one iOS and one Android app.
  ios: {
    ...config.ios,
    bundleIdentifier: 'com.maybesitter.app',
    supportsTablet: false,
    // Committed on purpose (UC-1.7 #151): these files identify the Firebase
    // project and authorise nothing. The API keys they carry are restricted to
    // this bundle id / package name and to Identity Toolkit, Token Service and
    // Firebase Installations.
    googleServicesFile: './firebase/GoogleService-Info.plist',
  },
  android: {
    ...config.android,
    package: 'com.maybesitter.app',
    googleServicesFile: './firebase/google-services.json',
  },
  plugins: [
    ...(config.plugins ?? []),
    '@react-native-firebase/app',
    '@react-native-firebase/auth',
    // React Native Firebase's iOS SDK needs static frameworks under Expo's
    // prebuild; without this the pods link dynamically and the app crashes on
    // launch. The deployment target follows the Firebase Apple SDK's minimum.
    ['expo-build-properties', { ios: { useFrameworks: 'static', deploymentTarget: '16.4' } }],
  ],
  extra: {
    ...config.extra,
    appEnv: APP_ENV,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
  },
});

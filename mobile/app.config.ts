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
  ios: { ...config.ios, bundleIdentifier: 'com.maybesitter.app', supportsTablet: false },
  android: { ...config.android, package: 'com.maybesitter.app' },
  extra: {
    ...config.extra,
    appEnv: APP_ENV,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
  },
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  apiMode: process.env.EXPO_PUBLIC_API_MODE,
});
if (problems.length > 0) throw new Error(releaseConfigErrorMessage(problems));

/**
 * The Web OAuth client Firebase created when Google sign-in was enabled
 * (UC-1.2 #146).
 *
 * Read from the committed `google-services.json` rather than from an
 * environment variable that has to be set identically on three EAS profiles
 * and can be forgotten on one of them. It is a public identifier, it already
 * lives in that file, and taking it from there means the Google button cannot
 * be pointed at a different project than Firebase is.
 * `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` overrides it if that is ever needed.
 */
function googleWebClientId(): string | null {
  const override = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();
  if (override !== '') return override;
  try {
    const services = JSON.parse(
      readFileSync(join(__dirname, 'firebase', 'google-services.json'), 'utf8'),
    ) as { client?: Array<{ oauth_client?: Array<{ client_id?: string; client_type?: number }> }> };
    // `client_type: 3` is the web client; 1 is Android and 2 is iOS.
    const web = services.client?.[0]?.oauth_client?.find(client => client.client_type === 3);
    return web?.client_id ?? null;
  } catch {
    // A missing or unreadable file means the Google button is hidden, not a
    // build failure: email sign-in still works.
    return null;
  }
}

/**
 * App Transport Security (UC-1.6a #150 step 3).
 *
 * Expo SDK 57 puts `NSAllowsArbitraryLoads: true` in the Info.plist of *every*
 * profile — production included — so a release build would be allowed to make
 * plain-HTTP requests to any host. That is the exact hole #150 asks to close,
 * and `expo config --type introspect` is how it was found.
 *
 * A development build keeps the localhost exception, because the whole point
 * of `EXPO_PUBLIC_API_BASE_URL=http://localhost:3000` is talking to a laptop.
 * Everything else gets arbitrary loads off, with no exception domains: the app
 * speaks HTTPS to Cloud Run and to Google, and nothing else.
 */
function appTransportSecurity(appEnv: AppEnv): Record<string, unknown> {
  if (appEnv === 'development') {
    return {
      NSAllowsArbitraryLoads: true,
      NSExceptionDomains: {
        localhost: { NSExceptionAllowsInsecureHTTPLoads: true },
      },
    };
  }
  return { NSAllowsArbitraryLoads: false };
}

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
    // Adds the entitlement at prebuild (UC-1.1 #145). The capability still
    // has to be enabled on the App ID in the Apple Developer portal; EAS
    // syncs it at build time. Declared now because adding it later
    // re-provisions the whole build.
    usesAppleSignIn: true,
    infoPlist: {
      ...config.ios?.infoPlist,
      // The launcher name, which `name` above only sets for the project.
      CFBundleDisplayName: 'MaybeSitter',
      NSAppTransportSecurity: appTransportSecurity(APP_ENV),
    },
    // Standard HTTPS only, so the app is outside the US export-compliance
    // question App Store Connect asks on every single upload.
    config: { ...config.ios?.config, usesNonExemptEncryption: false },
    // The App Group the home-screen widget will read the next step from
    // (UC-3.R1 #203). Declared now because EAS syncs capabilities to the App
    // ID at build time, and adding it later re-provisions.
    entitlements: {
      ...config.ios?.entitlements,
      'com.apple.security.application-groups': ['group.com.maybesitter.app'],
    },
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
    // Nothing on this device is worth restoring: commitments live in
    // Firestore under the uid, and signing in is what brings them back. See
    // plugins/withDataExtractionRules.js for why this alone is not enough.
    allowBackup: false,
    // Permissions Expo's dependencies pull in transitively and this app has
    // no use for. An unexplained permission on a store listing costs trust,
    // and `SYSTEM_ALERT_WINDOW` in particular reads as spyware.
    blockedPermissions: [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
  },
  plugins: [
    ...(config.plugins ?? []),
    '@react-native-firebase/app',
    '@react-native-firebase/auth',
    // Reads the reversed client id out of `ios.googleServicesFile`, so no
    // `iosUrlScheme` has to be repeated here.
    '@react-native-google-signin/google-signin',
    // React Native Firebase's iOS SDK needs static frameworks under Expo's
    // prebuild; without this the pods link dynamically and the app crashes on
    // launch. The deployment target follows the Firebase Apple SDK's minimum.
    ['expo-build-properties', { ios: { useFrameworks: 'static', deploymentTarget: '16.4' } }],
    './plugins/withDataExtractionRules',
  ],
  extra: {
    ...config.extra,
    appEnv: APP_ENV,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
    googleWebClientId: googleWebClientId(),
    apiMode: process.env.EXPO_PUBLIC_API_MODE ?? null,
  },
});

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
  googleCalendarDemo: process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO,
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


/**
 * One `NSPrivacyCollectedDataTypes` entry (UC-4.3a, #178).
 *
 * Linked to identity and used for app functionality unless stated otherwise,
 * and never for tracking — MaybeSitter does not track, and writing that out per
 * entry is how the manifest stays honest when a type is added later.
 */
function collected(
  type: string,
  options: { linked?: boolean; purposes?: string[] } = {},
): {
  NSPrivacyCollectedDataType: string;
  NSPrivacyCollectedDataTypeLinked: boolean;
  NSPrivacyCollectedDataTypeTracking: boolean;
  NSPrivacyCollectedDataTypePurposes: string[];
} {
  return {
    NSPrivacyCollectedDataType: type,
    NSPrivacyCollectedDataTypeLinked: options.linked ?? true,
    NSPrivacyCollectedDataTypeTracking: false,
    NSPrivacyCollectedDataTypePurposes: options.purposes ?? ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
  };
}

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: `MaybeSitter${NAME_SUFFIX[APP_ENV]}`,
  slug: 'maybesitter',
  scheme: 'maybesitter',
  /**
   * iOS system strings in the languages the app speaks (UC-4.1, #176).
   *
   * Expo writes an `InfoPlist.strings` per language at prebuild, so the
   * microphone and speech prompts appear in Arabic or Hebrew rather than in
   * English. `CFBundleDisplayName` stays `MaybeSitter` in all three: the brand
   * is one word in Latin script everywhere, and a home-screen label that
   * changes with the device language is a different app to the person looking
   * for it.
   */
  locales: {
    ar: './locales/native/ar.json',
    he: './locales/native/he.json',
  },
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
      // The launcher name. It has to carry the same suffix as `name` above:
      // `CFBundleDisplayName` *overrides* the abstract `name`, so a bare
      // 'MaybeSitter' here would put the same label under every icon and a
      // tester with three builds installed could not tell them apart. Caught
      // by reading the generated plist, not by introspecting the config.
      CFBundleDisplayName: `MaybeSitter${NAME_SUFFIX[APP_ENV]}`,
      // The languages the bundle claims. Without it iOS treats the app as
      // English-only and ignores the per-locale strings above (#176 step 4).
      CFBundleLocalizations: ['en', 'ar', 'he'],
      NSAppTransportSecurity: appTransportSecurity(APP_ENV),
    },
    // Standard HTTPS only, so the app is outside the US export-compliance
    // question App Store Connect asks on every single upload.
    config: { ...config.ios?.config, usesNonExemptEncryption: false },
    /**
     * The app's own `PrivacyInfo.xcprivacy` (UC-4.3a, #178).
     *
     * ── Why the app declares what its dependencies use ───────────
     *
     * Apple does not reliably read manifests out of **static** CocoaPods, and
     * this app is built with static frameworks because React Native Firebase
     * needs them (`useFrameworks: 'static'`). So the required-reason APIs that
     * Expo modules, React Native core and Firebase use have to be declared
     * here, in the app target, or the upload is answered with ITMS-91053.
     *
     * ── These four are not a guess ───────────────────────────────
     *
     * They are the union of every `NSPrivacyAccessedAPITypes` entry in the
     * manifests actually shipped inside `node_modules`, read with a plist
     * parser rather than transcribed from the issue:
     *
     *   DiskSpace       85F4.1, E174.1   expo-file-system, RN core
     *   FileTimestamp   0A2A.1, 3B52.1, C617.1
     *   SystemBootTime  35F9.1
     *   UserDefaults    CA92.1
     *
     * `scripts/check-privacy-manifests.mjs` recomputes that union from the
     * installed tree and fails if this list no longer covers it, so adding a
     * dependency that needs a new reason is caught in CI rather than by Apple.
     *
     * `1C8F.1` — UserDefaults in an App Group — is deliberately **absent**. The
     * entitlement is declared above, but nothing reads the group yet; the
     * widget bridge that will (UC-3.R1 #203) does not exist. Declaring a reason
     * the app does not use would be over-declaring, which is the same kind of
     * inaccuracy as under-declaring.
     */
    privacyManifests: {
      // MaybeSitter does not track. No ATT prompt, no tracking domains.
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryFileTimestamp',
          NSPrivacyAccessedAPITypeReasons: ['0A2A.1', '3B52.1', 'C617.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategorySystemBootTime',
          NSPrivacyAccessedAPITypeReasons: ['35F9.1'],
        },
        {
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryDiskSpace',
          NSPrivacyAccessedAPITypeReasons: ['85F4.1', 'E174.1'],
        },
      ],
      /**
       * What the app collects, which must equal the App Store label table in
       * UC-4.3b (#179).
       *
       * Every entry is `Tracking: false`, because none of it is used to track.
       * Crash data is the one type that is **not** linked to identity: the
       * Crashlytics wrapper (UC-4.4 #180) never calls `setUserId`, so a crash
       * report cannot be tied back to a person.
       *
       * `OtherUserContent` is the capture text itself — the most sensitive
       * thing here, and the reason it is declared plainly rather than folded
       * into something vaguer.
       */
      NSPrivacyCollectedDataTypes: [
        collected('NSPrivacyCollectedDataTypeEmailAddress'),
        collected('NSPrivacyCollectedDataTypeName'),
        collected('NSPrivacyCollectedDataTypeUserID'),
        // The FCM registration token.
        collected('NSPrivacyCollectedDataTypeDeviceID'),
        // Captures, and the commitments made from them.
        collected('NSPrivacyCollectedDataTypeOtherUserContent'),
        // Not linked: no `setUserId`, so a crash cannot be tied to a person.
        collected('NSPrivacyCollectedDataTypeCrashData', { linked: false }),
        collected('NSPrivacyCollectedDataTypeProductInteraction', {
          purposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality', 'NSPrivacyCollectedDataTypePurposeAnalytics'],
        }),
      ],
    },
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
      /**
       * Blocked before anything can ask for them (UC-4.3b, #179).
       *
       * Nothing requests these today, which is exactly when to block them: a
       * library added six months from now can pull one into the merged
       * manifest without a line of our code changing, and the first anyone
       * would hear of it is a Play policy warning on a release build.
       *
       * `USE_EXACT_ALARM` is the one that matters most. It grants exact alarms
       * without asking the user, and Play restricts it to alarm-clock and
       * calendar apps. MaybeSitter is neither: reminders the user set are
       * `SCHEDULE_EXACT_ALARM` with an honest fallback when it is denied
       * (S3 #196/#197), never a permission that takes the choice away.
       *
       * `USE_FULL_SCREEN_INTENT` lights up a locked phone with a full-screen
       * takeover. A product whose whole premise is that it does not nag has no
       * business holding it.
       */
      'android.permission.USE_EXACT_ALARM',
      'android.permission.USE_FULL_SCREEN_INTENT',
    ],
  },
  plugins: [
    ...(config.plugins ?? []),
    // `disableSPM` is required, not optional. React Native Firebase 26 resolves
    // firebase-ios-sdk through Swift Package Manager, whose products are
    // automatic libraries — so under `useFrameworks: 'static'` every
    // react-native-firebase pod embeds its own copy of Firebase and they
    // collide at link time as duplicate symbols. `pod install` refuses
    // outright. This forces the CocoaPods path, which static linkage supports.
    //
    // UC-1.7 (#151) step 1 asked for static frameworks because older versions
    // needed them; v26 needs static frameworks *and* this. Found by running
    // `expo prebuild`, not by introspecting the config.
    ['@react-native-firebase/app', { ios: { disableSPM: true } }],
    '@react-native-firebase/auth',
    // Reads the reversed client id out of `ios.googleServicesFile`, so no
    // `iosUrlScheme` has to be repeated here.
    '@react-native-google-signin/google-signin',
    // React Native Firebase's iOS SDK needs static frameworks under Expo's
    // prebuild; without this the pods link dynamically and the app crashes on
    // launch. The deployment target follows the Firebase Apple SDK's minimum.
    /*
     * On-device dictation (UC-2.3, #163).
     *
     * The plugin adds `RECORD_AUDIO` and the Android `<queries>` entry a
     * `RecognitionService` needs to be discoverable at all. Both permission
     * strings say what actually happens: the device turns speech into text, and
     * MaybeSitter is handed the text. It never receives the audio, and saying so
     * in the prompt is the only place most people will ever read it.
     */
    ['expo-speech-recognition', {
      microphonePermission:
        'MaybeSitter uses the microphone only while you hold the mic button to dictate a reminder.',
      speechRecognitionPermission:
        'Your device turns your speech into text. MaybeSitter never receives the audio.',
      androidSpeechServicePackages: ['com.google.android.googlequicksearchbox', 'com.google.android.as'],
    }],
    // The date and time pickers on the capture review sheet (UC-2.4, #164).
    // A config plugin rather than autolinking alone, because the Android side
    // needs its own theme resources merged into the manifest.
    '@react-native-community/datetimepicker',
    ['expo-build-properties', { ios: { useFrameworks: 'static', deploymentTarget: '16.4' } }],
    /*
     * The launch screen (UC-4.1, #176 step 3).
     *
     * The plugin generates the iOS storyboard and the Android 12+ splash API
     * resources; without it neither platform has a launch screen at all and the
     * app opens on a white rectangle. `dark` is given its own background rather
     * than left to invert: the brand mark is drawn for a light ground and
     * inverting it is not the same image.
     */
    ['expo-splash-screen', {
      image: './assets/splash-icon.png',
      imageWidth: 200,
      resizeMode: 'contain',
      backgroundColor: '#F5F7F8',
      dark: { image: './assets/splash-icon.png', backgroundColor: '#101416' },
    }],
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

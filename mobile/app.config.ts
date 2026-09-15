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
  testCrash: process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH,
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
    /**
     * The three home-screen appearances iOS 18 asks for (UC-4.1, #176).
     *
     * All three are the *same* drawing — the chevron, its gradient and the
     * construction guides — regenerated from `assets/icon.png` rather than
     * redrawn, so a person who changes their home screen to dark or tinted
     * still recognises the app they installed.
     *
     * `dark` is the master with its LAB **lightness** inverted and lifted, hue
     * and chroma untouched. That is not an RGB negate, which would turn a blue
     * mark orange: the mark stays the same blue, and the ground goes from pale
     * to near-black. It matters that the *gradient* survives — the chevron is
     * drawn fading into its ground at the tips, and inverting lightness is what
     * keeps it fading into the dark ground instead of glowing against it.
     *
     * `tinted` is that dark variant in greyscale with the mark lifted well
     * above the ground. iOS composites its own tint gradient over a fully
     * opaque greyscale image and maps luminance to it, so anything that has to
     * read has to be *lighter* than the background — a coloured icon here comes
     * out as mud.
     *
     * All three are opaque. Expo SDK 57 preserves transparency only in `dark`
     * and flattens `light`/`tinted` onto white
     * (`@expo/prebuild-config/build/plugins/icons/withIosIcons.js`:
     * `removeTransparency: appearance !== 'dark'`), and an alpha channel in the
     * light icon is an App Store rejection. Giving `dark` its own opaque ground
     * rather than letting the system gradient show through is the same choice
     * the splash screen makes below, for the same reason: the brand ground is
     * part of the mark, not a backdrop.
     *
     * Verified by reading the generated
     * `ios/MaybeSitter/Images.xcassets/AppIcon.appiconset/Contents.json` after
     * `expo prebuild`, not by introspecting this file.
     */
    icon: {
      light: './assets/icon.png',
      dark: './assets/icon-dark.png',
      tinted: './assets/icon-tinted.png',
    },
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
      /*
       * Remote notifications while the app is not in front (UC-3.0b, #184).
       *
       * Without it, a push that arrives to a backgrounded or killed app cannot
       * wake the code that re-presents it, so the "a test push reaches a killed
       * app" criterion is unreachable. `aps-environment` is added by the
       * expo-notifications plugin and flipped to `production` by EAS for store
       * builds, so it is deliberately not written here.
       */
      UIBackgroundModes: ['remote-notification'],
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
     * `1C8F.1` — UserDefaults in an App Group — became **true** with UC-3.0
     * (#183) and is declared below. It was deliberately absent before, because
     * the entitlement existed and nothing read the group; the share extension
     * `expo-share-intent` generates reads and writes
     * `UserDefaults(suiteName: "group.com.maybesitter.app")` in both directions
     * (the generated `ios/ShareExtension/ShareViewController.swift`, five call
     * sites, and `ExpoShareIntentModule.swift`), which is exactly what that
     * reason describes. `scripts/check-privacy-manifests.mjs` cannot see it —
     * the extension is generated at prebuild and is in neither `node_modules`
     * nor `targets/` — so this one was read out of `expo prebuild`'s output
     * rather than out of the installed tree, and this comment is that record.
     *
     * The extension is a second bundle with a manifest of its own, which the
     * dependency generates declaring `CA92.1` alone. `withShareExtensionFixups`
     * adds `1C8F.1` there too: the bundle that makes the suite call is the one
     * that has to declare the reason for it.
     */
    privacyManifests: {
      // MaybeSitter does not track. No ATT prompt, no tracking domains.
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyAccessedAPITypes: [
        {
          // CA92.1: the app's own UserDefaults. 1C8F.1: the share extension's
          // App Group suite (UC-3.0, #183) — see the note above.
          NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
          NSPrivacyAccessedAPITypeReasons: ['CA92.1', '1C8F.1'],
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
       * Crashlytics wrapper (UC-4.4 #180) never calls `setUserId`, and a test
       * greps the app for a call to it — so a crash report cannot be tied back
       * to a person.
       *
       * Crashlytics is a real dependency as of #180, so this entry is now true.
       * `DeviceID` below is the one that is not; see the note on it.
       *
       * `OtherUserContent` is the capture text itself — the most sensitive
       * thing here, and the reason it is declared plainly rather than folded
       * into something vaguer.
       */
      NSPrivacyCollectedDataTypes: [
        collected('NSPrivacyCollectedDataTypeEmailAddress'),
        collected('NSPrivacyCollectedDataTypeName'),
        collected('NSPrivacyCollectedDataTypeUserID'),
        /*
         * The FCM registration token, which as of UC-3.0b (#184) this app
         * really does collect.
         *
         * It was declared ahead of the fact (#179 §2), with a note saying so,
         * because removing it and putting it back would mean re-provisioning
         * the label. `@react-native-firebase/messaging` is a dependency now,
         * `src/notifications/pushRegistration.ts` reads the token and
         * `POST /api/mobile/devices` stores it under the uid — so the entry is
         * true, and linked to identity, which is what it has always said.
         *
         * The token is deleted when the user signs out
         * (`DELETE /api/mobile/devices/{installationId}`, then
         * `deleteToken()`) and with the account-deletion cascade (#149).
         */
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
    /*
     * The one alarm permission this app asks for (UC-3.11, #196).
     *
     * `POST_NOTIFICATIONS` and `RECEIVE_BOOT_COMPLETED` are **not** here
     * because expo-notifications declares both in its own
     * `AndroidManifest.xml` and the merger brings them in; repeating them
     * would be a second place for them to be right. `SCHEDULE_EXACT_ALARM` it
     * does not declare, and it is the user-revocable one — the contrast with
     * `USE_EXACT_ALARM` in `blockedPermissions` below is the whole point.
     *
     * Verified rather than assumed: `ExpoSchedulingDelegate.setupAlarm`
     * (SDK 57) calls `alarmManager.canScheduleExactAlarms()` and falls back to
     * `setAndAllowWhileIdle` when it is denied, rather than throwing. So a
     * soft reminder on an Android 14 phone with "Alarms & reminders" revoked
     * still fires — a few minutes late at worst, which for a heads-up an hour
     * ahead is not a difference anybody can feel.
     */
    permissions: [
      ...(config.android?.permissions ?? []),
      'android.permission.SCHEDULE_EXACT_ALARM',
    ],
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
    /*
     * Crash reporting (UC-4.4, #180).
     *
     * The plugin adds the iOS dSYM upload build phase and the Android
     * Crashlytics Gradle plugin, both of which run inside EAS Build — so
     * symbols are uploaded by the build rather than by somebody remembering to.
     * A crash report with no symbols is a stack of hex addresses, which is the
     * same as no crash report.
     *
     * What it may contain is decided in `src/lib/crash.ts`, not here: a stack,
     * the build's own facts, and nothing about the person.
     */
    '@react-native-firebase/crashlytics',
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
    ['expo-build-properties', {
      ios: { useFrameworks: 'static', deploymentTarget: '16.4' },
      /*
       * R8 on release builds (UC-4.4, #180 step 5).
       *
       * Crashlytics needs the mapping file to deobfuscate Java and Kotlin
       * frames, and the Gradle plugin above uploads it — but only if there is
       * one, which means minification has to be on. Without this an Android
       * crash arrives as obfuscated class names nobody can act on.
       */
      android: { enableMinifyInReleaseBuilds: true },
    }],
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
      dark: { image: './assets/splash-icon.png', backgroundColor: '#101416' }
    }],
    /*
     * Local notifications, channels and categories (UC-3.11, #196).
     *
     * `defaultChannel` is what anything arriving without a channel lands on,
     * and it is the same id `mobile/src/notifications/channels.ts` creates and
     * `lib/push/pushService.ts` sends to — Android *drops* a notification whose
     * channel does not exist, so the three have to agree and a test checks that
     * they do.
     *
     * `icon` is the monochrome adaptive icon. Android reads only its alpha
     * channel and tints the silhouette itself, which is exactly what that file
     * is: a grey mark on transparent. It carries the adaptive icon's safe-zone
     * padding, so the glyph sits a little small in the status bar — worth a
     * look on a device, and still better than the white square Android draws
     * when no icon is given.
     */
    ['expo-notifications', {
      icon: './assets/android-icon-monochrome.png',
      color: '#1F7A8C',
      defaultChannel: 'maybesitter_general',
    }],
    /*
     * The keychain entry the installation id lives in (UC-3.0b, #184).
     *
     * One value, `installation_id`, written once and never synced — see
     * `src/lib/installationId.ts` for why it is here rather than in
     * AsyncStorage, and why it is not a credential.
     *
     * Both options are off, and both were found by a test rather than guessed:
     *
     * `faceIDPermission: false` because the plugin otherwise writes an English
     * `NSFaceIDUsageDescription` into the Info.plist. Nothing here calls
     * `requireAuthentication`, so that string is a permission this app asks
     * for and never uses — shown untranslated, at the moment somebody decides.
     * `appConfig.test.ts` ("says every permission in Arabic and Hebrew") went
     * red on it.
     *
     * `configureAndroidBackup: false` because the plugin points
     * `android:dataExtractionRules` and `android:fullBackupContent` at its own
     * two files, and `./plugins/withDataExtractionRules` (UC-1.6a, #150)
     * already points them at rules that exclude every domain from cloud backup
     * *and* device transfer. Two plugins writing one manifest attribute is a
     * race decided by plugin order; the stricter rules win it by not being
     * raced.
     */
    ['expo-secure-store', { faceIDPermission: false, configureAndroidBackup: false }],
    /*
     * FCM tokens and message receipt (UC-3.0b, #184).
     *
     * React Native Firebase owns both; expo-notifications owns local
     * notifications, channels, categories and tap responses. That split is not
     * a convention — it is how the two libraries' manifests resolve. Both
     * declare a service for `com.google.firebase.MESSAGING_EVENT`, and
     * expo-notifications declares its intent filter at `android:priority="-1"`
     * while RNFB's is at the default, so the merged manifest picks RNFB.
     */
    '@react-native-firebase/messaging',
    './plugins/withDataExtractionRules',
    /*
     * Two corrections to what `expo-share-intent` generates, which is why this
     * is listed *before* it (UC-3.0, #183).
     *
     * Config-plugin mods execute in reverse registration order — each wrapper
     * runs the mod already registered for its key and then its own action — so
     * the plugin that has to see everyone else's work goes first in this array.
     * It de-duplicates the App Group both declarations ask for, and it fixes
     * the share sheet's label, which the dependency ties to the Xcode target
     * name. Both faults are visible only in `expo prebuild`'s output, never in
     * `expo config --type introspect`. See plugins/withShareExtensionFixups.js.
     */
    './plugins/withShareExtensionFixups',
    /*
     * The native share targets (UC-3.0, #183).
     *
     * `expo-share-intent@8` is the choice. It is the only maintained option
     * whose peer range is `expo: ^57` (this app is SDK 57 / RN 0.86 / React
     * 19.2), it generates both sides — the iOS Share Extension target and the
     * Android `SEND` / `SEND_MULTIPLE` intent filters — from this config alone,
     * and it exposes the result to JavaScript. `ios/` and `android/` are
     * generated here (CNG) and `git ls-files mobile/ios` is empty, so a config
     * plugin is the *only* way a share target can exist in this repository at
     * all; an approach needing hand-written Swift in a committed `ios/` folder
     * was never available.
     *
     * ── The Android MIME list ────────────────────────────────────
     *
     * The plugin's own TypeScript narrows `androidIntentFilters` to
     * text/image/video/*-star. That is a hint, not a validator: the
     * implementation writes each string straight into the manifest as a
     * `<data android:mimeType>` (read
     * `plugin/build/android/withAndroidIntentFilters.js`), so `application/pdf`,
     * `application/zip` and `text/calendar` produce exactly the filters #183
     * asks for. They are listed as the issue names them, not narrowed to fit a
     * type that is looser than it looks.
     *
     * ── `singleTask` ─────────────────────────────────────────────
     *
     * The plugin sets the main activity's launch mode. Deep links
     * (`maybesitter://`) and notification taps have to keep working under it;
     * `.maestro/share-deeplink-regression.yaml` is the regression, and it needs
     * a device build.
     *
     * ── `iosShareExtensionName` is the target name, not the label ─
     *
     * #183's sketch sets it to `MaybeSitter`. That value is used for **both**
     * the Xcode target name and the extension's `CFBundleDisplayName`, and the
     * target-creating mod returns early when a target of that name already
     * exists — which it does, because it is the app. Prebuild then logs
     * "MaybeSitter already exists in project. Skipping…", writes the Swift and
     * the plists, and produces no extension target at all: no share sheet
     * entry, and no `com.apple.product-type.app-extension` in the generated
     * `project.pbxproj`. So the target is `ShareExtension`, and
     * `withShareExtensionFixups` puts `MaybeSitter` back as the label.
     *
     * ── The extension's bundle id ────────────────────────────────
     *
     * `com.maybesitter.app.share-extension`, from
     * `getShareExtensionBundledIdentifier` with no override — independent of
     * the name above, and confirmed in the generated `project.pbxproj`.
     * UC-4.3a (#178) and 4.6a need it for the store listing and the
     * provisioning profile.
     */
    ['expo-share-intent', {
      iosActivationRules: {
        NSExtensionActivationSupportsText: true,
        NSExtensionActivationSupportsWebURLWithMaxCount: 1,
        NSExtensionActivationSupportsImageWithMaxCount: 5,
        NSExtensionActivationSupportsFileWithMaxCount: 1,
      },
      // The zip is the iOS WhatsApp export shape (UC-3.5 #189). The extension
      // only hands files over through the App Group; it never uploads.
      androidIntentFilters: ['text/*', 'image/*', 'application/pdf', 'application/zip', 'text/calendar'],
      androidMultiIntentFilters: ['image/*'],
      iosAppGroupIdentifier: 'group.com.maybesitter.app',
      iosShareExtensionName: 'ShareExtension',
    }],
  ],
  extra: {
    ...config.extra,
    appEnv: APP_ENV,
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL ?? null,
    googleWebClientId: googleWebClientId(),
    apiMode: process.env.EXPO_PUBLIC_API_MODE ?? null,
  },
});

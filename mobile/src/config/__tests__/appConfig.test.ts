import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/**
 * The shipping configuration, read the way a build reads it.
 *
 * These assertions are not about `app.config.ts`'s source — they are about
 * what `expo config --type introspect` produces after every plugin has run,
 * which is what actually lands in the Info.plist and the manifest.
 *
 * That distinction found a real hole: Expo SDK 57 puts
 * `NSAllowsArbitraryLoads: true` in *every* profile's Info.plist, production
 * included, so a release build was allowed plain HTTP to any host. Reading the
 * source would not have shown it.
 */

const ROOT = join(__dirname, '..', '..', '..');

interface IntrospectedConfig {
  name: string;
  plugins: Array<string | [string, unknown]>;
  ios: {
    icon?: string | { light?: string; dark?: string; tinted?: string };
    bundleIdentifier?: string;
    googleServicesFile?: string;
    config?: { usesNonExemptEncryption?: boolean };
    entitlements?: Record<string, unknown>;
    infoPlist?: Record<string, unknown>;
    privacyManifests?: {
      NSPrivacyCollectedDataTypes?: Array<{
        NSPrivacyCollectedDataType: string;
        NSPrivacyCollectedDataTypeLinked: boolean;
        NSPrivacyCollectedDataTypeTracking: boolean;
        NSPrivacyCollectedDataTypePurposes: string[];
      }>;
    };
    supportsTablet?: boolean;
  };
  android: {
    package?: string;
    googleServicesFile?: string;
    allowBackup?: boolean;
    blockedPermissions?: string[];
    /**
     * Undefined today: the app declares no explicit Android permissions and
     * everything in the merged manifest comes from library manifests. Typed
     * anyway, so the check below keeps working the day one is added — which is
     * exactly when it needs to.
     */
    permissions?: string[];
  };
  extra?: Record<string, unknown>;
  orientation?: string;
  icon?: string;
  locales?: Record<string, string>;
}

/**
 * A PNG's own header, because Apple rejects on the file and not on the config.
 *
 * `IHDR` is always the first chunk: width and height at bytes 16–23, the colour
 * type at byte 25. Colour types 4 and 6 carry an alpha channel; a `tRNS` chunk
 * adds transparency to the types that do not, so both are checked.
 */
function pngFacts(path: string): { width: number; height: number; hasAlpha: boolean } {
  const bytes = readFileSync(path);
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  expect(bytes.subarray(12, 16).toString('ascii')).toBe('IHDR');
  const colorType = bytes[25];
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
    hasAlpha: colorType === 4 || colorType === 6 || bytes.includes('tRNS'),
  };
}

/** Runs the real Expo config resolution for one profile. Slow, and the point. */
function introspect(appEnv: 'development' | 'staging' | 'production'): IntrospectedConfig {
  const apiBaseUrl = appEnv === 'development' ? 'http://localhost:3000' : 'https://api.example.com';
  const stdout = execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
    cwd: ROOT,
    env: { ...process.env, APP_ENV: appEnv, EXPO_PUBLIC_API_BASE_URL: apiBaseUrl, EXPO_PUBLIC_DEV_BEARER_TOKEN: '' },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout) as IntrospectedConfig;
}

// One resolution per profile, shared across cases: each takes seconds.
const configs = {
  development: introspect('development'),
  staging: introspect('staging'),
  production: introspect('production'),
};

const PROFILES = ['development', 'staging', 'production'] as const;

describe('identity', () => {
  it('uses one bundle id and package on every profile', () => {
    for (const profile of PROFILES) {
      expect(configs[profile].ios.bundleIdentifier).toBe('com.maybesitter.app');
      expect(configs[profile].android.package).toBe('com.maybesitter.app');
    }
  });

  it('shows "MaybeSitter" in production, and says so in the other profiles', () => {
    expect(configs.production.name).toBe('MaybeSitter');
    // A tester with three builds installed has to be able to tell them apart,
    // and the *launcher* label is the only place they can. `CFBundleDisplayName`
    // overrides the abstract `name`, so asserting `name` alone was not enough:
    // the first version hard-coded 'MaybeSitter' here and every build came out
    // with the same label. Found by reading the generated plist.
    const displayNames = {
      development: configs.development.ios.infoPlist?.CFBundleDisplayName,
      staging: configs.staging.ios.infoPlist?.CFBundleDisplayName,
      production: configs.production.ios.infoPlist?.CFBundleDisplayName,
    };
    expect(displayNames).toEqual({
      development: 'MaybeSitter (Dev)',
      staging: 'MaybeSitter (Staging)',
      production: 'MaybeSitter',
    });
    expect(configs.staging.name).toBe('MaybeSitter (Staging)');
    expect(configs.development.name).toBe('MaybeSitter (Dev)');
    // Three distinct labels, not two that happen to match.
    expect(new Set(Object.values(displayNames)).size).toBe(3);
  });
});

describe('iOS hardening', () => {
  it.each(['staging', 'production'] as const)('forbids arbitrary HTTP loads in %s', profile => {
    const ats = configs[profile].ios.infoPlist?.NSAppTransportSecurity as Record<string, unknown>;
    expect(ats.NSAllowsArbitraryLoads).toBe(false);
    // No exception domains either: the app speaks HTTPS to Cloud Run and to
    // Google, and an exception list is a place for one to be added quietly.
    expect(ats.NSExceptionDomains).toBeUndefined();
  });

  it('still allows a development build to reach a laptop', () => {
    const ats = configs.development.ios.infoPlist?.NSAppTransportSecurity as Record<string, unknown>;
    expect(ats.NSAllowsArbitraryLoads).toBe(true);
  });

  it('declares standard encryption only, on every profile', () => {
    for (const profile of PROFILES) {
      expect(configs[profile].ios.config?.usesNonExemptEncryption).toBe(false);
    }
  });

  it('declares the App Group the widget will read, exactly once', () => {
    // Once, not twice. Two things now ask for this group: `ios.entitlements` in
    // `app.config.ts` (for the widget, #203) and `expo-share-intent`, whose own
    // plugin *prepends* the group it needs to whatever is already there
    // (plugin/build/ios/withIosAppEntitlements.js). Without
    // `./plugins/withDedupedAppGroups` this array is the same string twice —
    // which is a lie in a file EAS syncs to the App ID's capabilities.
    //
    // This runs after every mod has, so it is evidence about the entitlements
    // that get written, not about the source that asks for them (UC-3.0, #183).
    expect(configs.production.ios.entitlements?.['com.apple.security.application-groups']).toEqual([
      'group.com.maybesitter.app',
    ]);
  });

  it('registers the share target, and the fix-up plugin ahead of it', () => {
    const names = configs.production.plugins.map(plugin => (typeof plugin === 'string' ? plugin : plugin[0]));
    expect(names).toContain('expo-share-intent');
    // Ahead of it in the array, which means *after* it at run time: config
    // plugin mods execute last-registered-first, so the plugin that has to see
    // everyone else's work is listed first. Getting this backwards is silent —
    // the dedupe simply runs before there is anything to dedupe — so the order
    // is asserted rather than left to a comment.
    expect(names.indexOf('./plugins/withShareExtensionFixups')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('./plugins/withShareExtensionFixups')).toBeLessThan(names.indexOf('expo-share-intent'));
  });

  it('asks the share target for the MIME types #183 names, and for our App Group', () => {
    const entry = configs.production.plugins.find(
      plugin => Array.isArray(plugin) && plugin[0] === 'expo-share-intent',
    ) as [string, Record<string, unknown>] | undefined;
    expect(entry).toBeDefined();
    const options = entry![1];
    expect(options.iosAppGroupIdentifier).toBe('group.com.maybesitter.app');
    // The plugin's own TypeScript narrows this to text/image/video; the
    // implementation writes each string straight into the manifest as a
    // `<data android:mimeType>`, so the three #183 adds are real filters and
    // not a type error waved through.
    expect(options.androidIntentFilters).toEqual([
      'text/*', 'image/*', 'application/pdf', 'application/zip', 'text/calendar',
    ]);
    expect(options.androidMultiIntentFilters).toEqual(['image/*']);
    // Not `MaybeSitter`, which #183's sketch asks for. That string is the Xcode
    // **target** name as well as the share sheet label, and the plugin's
    // target-creating mod returns early when a target of that name exists —
    // which it does, because it is the app. The extension would never be built.
    // `withShareExtensionFixups` restores the label; nothing restores a target
    // that was never created.
    expect(options.iosShareExtensionName).toBe('ShareExtension');
  });

  /**
   * The calendar permission (UC-3.1, #185).
   *
   * Two things, and the second is the one that would rot quietly.
   *
   * **Full access.** `expo-calendar`'s `writeOnlyAccess: true` writes
   * `NSCalendarsWriteOnlyAccessUsageDescription` *instead of*
   * `NSCalendarsFullAccessUsageDescription`, and under it an event can be
   * added and never looked up again — so reschedule, delete and "the user
   * removed it in Calendar" all become impossible. Someone tidying up towards
   * the smaller permission would break three acceptance criteria and no build
   * would fail; this is where that stops.
   *
   * **No Reminders.** The plugin writes two `NSReminders*UsageDescription`
   * keys by default for every app that installs it, and MaybeSitter never
   * opens the Reminders store. A purpose string for a store the app does not
   * touch is an unexplained permission on a store listing. `false` in
   * `app.config.ts` removes them; confirmed in the generated `Info.plist`
   * after `expo prebuild` as well as here.
   */
  it('asks for full calendar access and for no reminders at all', () => {
    for (const profile of PROFILES) {
      const plist = configs[profile].ios.infoPlist ?? {};
      expect(typeof plist.NSCalendarsFullAccessUsageDescription).toBe('string');
      expect(plist.NSCalendarsWriteOnlyAccessUsageDescription).toBeUndefined();
      expect(plist.NSRemindersUsageDescription).toBeUndefined();
      expect(plist.NSRemindersFullAccessUsageDescription).toBeUndefined();
      // The pre-iOS-17 key, which a 16.4 deployment target still needs.
      expect(typeof plist.NSCalendarsUsageDescription).toBe('string');
    }
    // And it says what it does with the access, rather than "access your
    // calendars". The prompt is the only sentence most people ever read.
    const copy = String(configs.production.ios.infoPlist?.NSCalendarsFullAccessUsageDescription);
    expect(copy).toContain('MaybeSitter');
    expect(copy.length).toBeGreaterThan(60);
  });

  it('never blocks the calendar permissions the feature needs', () => {
    // `blockedPermissions` removes a permission from the merged manifest. One
    // of these in that list would leave a build that asks the user for nothing
    // and fails every write at runtime, with no error anywhere in the config.
    for (const profile of PROFILES) {
      const blocked = configs[profile].android.blockedPermissions ?? [];
      expect(blocked).not.toContain('android.permission.READ_CALENDAR');
      expect(blocked).not.toContain('android.permission.WRITE_CALENDAR');
    }
  });

  it('declares Sign in with Apple, whose entitlement Expo derives (#145)', () => {
    // Declared now rather than when Apple is switched on: adding an
    // entitlement later re-provisions the whole build.
    for (const profile of PROFILES) {
      expect((configs[profile].ios as { usesAppleSignIn?: boolean }).usesAppleSignIn).toBe(true);
      expect(configs[profile].ios.entitlements?.['com.apple.developer.applesignin']).toEqual(['Default']);
    }
  });

  it('declares read-only HealthKit access for normalized readiness', () => {
    for (const profile of PROFILES) {
      const plist = configs[profile].ios.infoPlist ?? {};
      const entitlements = configs[profile].ios.entitlements ?? {};
      const purpose = String(plist.NSHealthShareUsageDescription ?? '');

      expect(entitlements['com.apple.developer.healthkit']).toBe(true);
      expect(entitlements).not.toHaveProperty('com.apple.developer.healthkit.access');
      expect(purpose).toContain('MaybeSitter');
      expect(purpose).toContain('readiness summary');
      expect(purpose).toContain('instead of raw Health data');
    }
  });

  it('declares normalized health readiness as app functionality data only', () => {
    const collected = configs.production.ios.privacyManifests?.NSPrivacyCollectedDataTypes ?? [];
    const health = collected.find(entry => entry.NSPrivacyCollectedDataType === 'NSPrivacyCollectedDataTypeHealth');

    expect(health).toEqual({
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeHealth',
      NSPrivacyCollectedDataTypeLinked: true,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
    });
  });

  it('pins the owner-approved Device ID and Crash data declarations (#327)', () => {
    const collected = configs.production.ios.privacyManifests?.NSPrivacyCollectedDataTypes ?? [];
    const byType = (type: string) => collected.find(entry => entry.NSPrivacyCollectedDataType === type);

    expect(byType('NSPrivacyCollectedDataTypeDeviceID')).toEqual({
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
      NSPrivacyCollectedDataTypeLinked: true,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
    });
    expect(byType('NSPrivacyCollectedDataTypeCrashData')).toEqual({
      NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeCrashData',
      NSPrivacyCollectedDataTypeLinked: false,
      NSPrivacyCollectedDataTypeTracking: false,
      NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
    });
  });
});

describe('Android hardening', () => {
  it('turns off backup on every profile', () => {
    for (const profile of PROFILES) expect(configs[profile].android.allowBackup).toBe(false);
  });

  it('registers the data-extraction plugin, which allowBackup alone cannot replace', () => {
    // On Android 12+ device-to-device transfer is a separate channel, and a
    // Keystore-encrypted value restored elsewhere cannot be decrypted.
    const names = configs.production.plugins.map(plugin => (typeof plugin === 'string' ? plugin : plugin[0]));
    expect(names).toContain('./plugins/withDataExtractionRules');
  });

  it('blocks the permissions this app has no use for', () => {
    for (const profile of PROFILES) {
      expect(configs[profile].android.blockedPermissions).toEqual([
        'android.permission.SYSTEM_ALERT_WINDOW',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.USE_EXACT_ALARM',
        'android.permission.USE_FULL_SCREEN_INTENT',
      ]);
    }
  });

  /**
   * The store-policy permissions (UC-4.3b, #179).
   *
   * Listed by name rather than checked as a set, so the failure message says
   * *which* one appeared. Each is a Play policy declaration or a rejection on
   * its own, and every one of them can arrive through a library's manifest
   * without a line of this repository changing — which is why this asserts the
   * absence rather than trusting that nobody added one.
   */
  /**
   * What this can and cannot prove.
   *
   * It checks what *we* declare. The merged manifest also contains whatever
   * the libraries declare, and that is only visible on a built AAB —
   * `bundletool dump manifest`, which needs an EAS build and therefore #158.
   * `blockedPermissions` above is the half that covers the libraries, by
   * removing a permission whoever added it never told us about.
   */
  it('never asks for a permission the stores would make us justify', () => {
    const forbidden = [
      // Play policy declarations, or outright restricted.
      'android.permission.USE_EXACT_ALARM',
      'android.permission.USE_FULL_SCREEN_INTENT',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.QUERY_ALL_PACKAGES',
      'android.permission.MANAGE_EXTERNAL_STORAGE',
      // SMS and call log: MaybeSitter reads none of them, and each is a
      // separate Play declaration with its own review. Location left this list
      // with place reminders (closure CL4) — see the case below, which pins
      // exactly the location permissions that feature holds.
      'android.permission.FOREGROUND_SERVICE_LOCATION',
      'android.permission.ACTIVITY_RECOGNITION',
      'android.permission.READ_SMS',
      'android.permission.RECEIVE_SMS',
      'android.permission.SEND_SMS',
      'android.permission.READ_CALL_LOG',
      'android.permission.WRITE_CALL_LOG',
      'android.permission.READ_CONTACTS',
    ];
    for (const profile of PROFILES) {
      const requested = configs[profile].android.permissions ?? [];
      for (const permission of forbidden) {
        expect(requested).not.toContain(permission);
      }
    }
  });

  /**
   * Place reminders (closure CL4): exactly the location permissions geofencing
   * needs, and no foreground service. Background location is what lets a
   * geofence fire while the app is not in front on Android 10+, and it carries
   * a Play Console declaration — an owner task, recorded in the lane report.
   */
  it('holds the location permissions place reminders need, and no location foreground service', () => {
    for (const profile of PROFILES) {
      const requested = configs[profile].android.permissions ?? [];
      expect(requested.filter(permission => /LOCATION/.test(permission)).sort()).toEqual([
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
      ]);
    }
  });

  /**
   * `SCHEDULE_EXACT_ALARM` is the one this app may eventually want, and
   * `USE_EXACT_ALARM` is the one it may not (#179 step 4).
   *
   * The difference is who decides: the first asks the user and can be refused,
   * the second takes the permission without asking and is restricted by Play
   * to alarm-clock and calendar apps. Blocking the second while leaving the
   * first available is the whole position, and it is easy to undo by accident.
   */
  it('keeps the exact-alarm permission that asks, and blocks the one that does not', () => {
    for (const profile of PROFILES) {
      const blocked = configs[profile].android.blockedPermissions ?? [];
      expect(blocked).toContain('android.permission.USE_EXACT_ALARM');
      expect(blocked).not.toContain('android.permission.SCHEDULE_EXACT_ALARM');
    }
  });
});

/**
 * Must reminders (UC-3.12a, #197): what the config has to carry for a strong
 * notification to be Time Sensitive on iOS, to have its sound on both
 * platforms, and to stay inside the permissions Play allows a non-alarm app.
 */
describe('Must reminders', () => {
  it('asks for Time Sensitive notifications on every profile, and never for critical alerts', () => {
    for (const profile of PROFILES) {
      const entitlements = configs[profile].ios.entitlements ?? {};
      expect(entitlements['com.apple.developer.usernotifications.time-sensitive']).toBe(true);
      expect(entitlements).not.toHaveProperty('com.apple.developer.usernotifications.critical-alerts');
    }
  });

  it('bundles the Must sound through the notifications plugin, and the file is under 30 seconds', () => {
    for (const profile of PROFILES) {
      const entry = configs[profile].plugins.find(plugin => Array.isArray(plugin) && plugin[0] === 'expo-notifications');
      expect(entry).toBeDefined();
      const options = (entry as [string, { sounds?: string[] }])[1];
      expect(options.sounds).toEqual(['./assets/sounds/maybesitter_hard.wav']);
    }
    // iOS replaces a custom sound of 30 seconds or more with the default one.
    // A PCM WAV's duration is its data size over its byte rate.
    const wav = readFileSync(join(ROOT, 'assets', 'sounds', 'maybesitter_hard.wav'));
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.readUInt16LE(20)).toBe(1); // linear PCM
    const byteRate = wav.readUInt32LE(28);
    let offset = 12;
    let dataBytes = 0;
    while (offset + 8 <= wav.length) {
      const id = wav.toString('ascii', offset, offset + 4);
      const size = wav.readUInt32LE(offset + 4);
      if (id === 'data') {
        dataBytes = size;
        break;
      }
      offset += 8 + size + (size % 2);
    }
    expect(dataBytes).toBeGreaterThan(0);
    expect(dataBytes / byteRate).toBeLessThan(30);
    // And it has a recorded license.
    expect(readFileSync(join(ROOT, 'assets', 'sounds', 'LICENSES.md'), 'utf8')).toContain('maybesitter_hard.wav');
  });

  it('blocks both alarm-clock permissions, and keeps the one that asks the user', () => {
    for (const profile of PROFILES) {
      const blocked = configs[profile].android.blockedPermissions ?? [];
      expect(blocked).toEqual(expect.arrayContaining([
        'android.permission.USE_EXACT_ALARM',
        'android.permission.USE_FULL_SCREEN_INTENT',
      ]));
      expect(configs[profile].android.permissions).toContain('android.permission.SCHEDULE_EXACT_ALARM');
    }
  });
});

describe('Firebase and Google', () => {
  it('points both platforms at the committed config files', () => {
    for (const profile of PROFILES) {
      expect(configs[profile].ios.googleServicesFile).toBe('./firebase/GoogleService-Info.plist');
      expect(configs[profile].android.googleServicesFile).toBe('./firebase/google-services.json');
    }
  });

  it('registers both Firebase plugins and the Google sign-in plugin', () => {
    const names = configs.production.plugins.map(plugin => (typeof plugin === 'string' ? plugin : plugin[0]));
    expect(names).toContain('@react-native-firebase/app');
    expect(names).toContain('@react-native-firebase/auth');
    expect(names).toContain('@react-native-google-signin/google-signin');
  });

  it('resolves the Web Client ID from the committed config, with no env var set', () => {
    expect(configs.production.extra?.googleWebClientId).toMatch(/\.apps\.googleusercontent\.com$/);
  });

  it('derives the iOS reversed-client-id URL scheme rather than repeating it', () => {
    const urlTypes = configs.production.ios.infoPlist?.CFBundleURLTypes as Array<{ CFBundleURLSchemes: string[] }>;
    const schemes = urlTypes.flatMap(entry => entry.CFBundleURLSchemes);
    expect(schemes).toContain('maybesitter');
    expect(schemes.some(scheme => scheme.startsWith('com.googleusercontent.apps.'))).toBe(true);
  });
});

describe('what a release build must never carry', () => {
  it.each(['staging', 'production'] as const)('refuses %s with the dev bearer token set', profile => {
    const apiBaseUrl = 'https://api.example.com';
    expect(() =>
      execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_ENV: profile,
          EXPO_PUBLIC_API_BASE_URL: apiBaseUrl,
          EXPO_PUBLIC_DEV_BEARER_TOKEN: 'leftover-token',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/CFG-1/);
  });

  it.each(['staging', 'production'] as const)('refuses %s with the calendar demo enabled', profile => {
    // The demo requests calendar scopes and writes an event. It must not be
    // possible to *make* a binary that could reach it (#152).
    expect(() =>
      execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_ENV: profile,
          EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com',
          EXPO_PUBLIC_DEV_BEARER_TOKEN: '',
          EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO: 'true',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/CFG-1/);
  });

  /**
   * The hidden test-crash row (UC-4.4, #180 step 8).
   *
   * Production only, and that asymmetry is the whole design: the row exists to
   * prove that a native crash and a JS error come back symbolicated, which can
   * only be shown on a release build — so staging has to be allowed to build
   * with it, and a store binary must not be buildable with it at all. Asserted
   * in both directions, because "allowed in staging" is the half a future
   * tidy-up would delete first.
   */
  it('refuses production with the test-crash row enabled', () => {
    expect(() =>
      execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_ENV: 'production',
          EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com',
          EXPO_PUBLIC_DEV_BEARER_TOKEN: '',
          EXPO_PUBLIC_ENABLE_TEST_CRASH: 'true',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/CFG-1/);
  });

  it('still builds staging with the test-crash row enabled', () => {
    expect(() =>
      execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_ENV: 'staging',
          EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com',
          EXPO_PUBLIC_DEV_BEARER_TOKEN: '',
          EXPO_PUBLIC_ENABLE_TEST_CRASH: 'true',
        },
        encoding: 'utf8',
        stdio: 'pipe',
        maxBuffer: 32 * 1024 * 1024,
      }),
    ).not.toThrow();
  });

  it.each(['staging', 'production'] as const)('refuses %s in mock API mode', profile => {
    expect(() =>
      execFileSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
        cwd: ROOT,
        env: {
          ...process.env,
          APP_ENV: profile,
          EXPO_PUBLIC_API_BASE_URL: 'https://api.example.com',
          EXPO_PUBLIC_DEV_BEARER_TOKEN: '',
          EXPO_PUBLIC_API_MODE: 'mock',
        },
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/CFG-1/);
  });
});

describe('the app as a person sees it (UC-4.1, #176)', () => {
  it('does not rotate, on either platform', () => {
    // v1 is a phone app held in one hand. A landscape layout nobody designed is
    // a layout nobody checked.
    for (const profile of PROFILES) {
      expect(configs[profile].orientation).toBe('portrait');
      expect(configs[profile].ios.supportsTablet).toBe(false);
    }
  });

  it('has a real icon, opaque and at the master size', () => {
    const icon = join(ROOT, configs.production.icon!.replace(/^\.\//, ''));
    expect(existsSync(icon)).toBe(true);
    // Not Expo's template icon, which is the md5 #176 names.
    expect(createHash('md5').update(readFileSync(icon)).digest('hex'))
      .not.toBe('c785f8932297af4acd5f5ccb7630f01c');
  });

  /**
   * The three iOS 18 home-screen appearances (#176).
   *
   * Removing `dark` or `tinted` from `app.config.ts` does not break a build,
   * does not fail a submission, and shows up only as an icon that ignores the
   * home screen it is sitting on — which is exactly the kind of regression
   * nobody notices. Every profile is checked because an icon set on one and not
   * another is the same defect with a longer fuse.
   */
  it('gives iOS a dark and a tinted icon as well as the light one', () => {
    for (const profile of PROFILES) {
      const icon = configs[profile].ios.icon;
      expect(`${profile}:${typeof icon}`).toBe(`${profile}:object`);
      expect(icon).toEqual({
        light: './assets/icon.png',
        dark: './assets/icon-dark.png',
        tinted: './assets/icon-tinted.png',
      });
    }
  });

  /**
   * The files themselves, read as bytes.
   *
   * `expo prebuild` hands each of these to sharp and writes the result into
   * `Images.xcassets/AppIcon.appiconset` with an
   * `appearances: [{ appearance: 'luminosity', value: … }]` entry. It preserves
   * transparency in `dark` and flattens `light` and `tinted` onto white
   * (`@expo/prebuild-config/.../withIosIcons.js`), so an alpha channel in the
   * light icon is an App Store rejection and an alpha channel in the tinted one
   * is a white rectangle where the mark should be. Neither is visible in the
   * config; both are visible in the PNG header.
   *
   * `dark` is held to the same rule even though Expo would let it through,
   * because the decision was to give it the brand's own dark ground rather than
   * let the system gradient show behind a cut-out — the same call the splash
   * screen makes. This assertion is where that decision is written down; a
   * transparent dark icon is a different design, not a tidy-up.
   */
  it('ships all three at the master size, with no alpha where Apple forbids it', () => {
    const variants = configs.production.ios.icon as { light: string; dark: string; tinted: string };
    for (const [appearance, relative] of Object.entries(variants)) {
      const path = join(ROOT, relative.replace(/^\.\//, ''));
      expect(`${appearance}:${existsSync(path)}`).toBe(`${appearance}:true`);
      const { width, height, hasAlpha } = pngFacts(path);
      expect(`${appearance}:${width}x${height}`).toBe(`${appearance}:1024x1024`);
      expect(`${appearance}:alpha:${hasAlpha}`).toBe(`${appearance}:alpha:false`);
    }
    // Three different drawings, not one file referenced three times: a copied
    // path would pass every assertion above and ship one appearance.
    const digests = Object.values(variants).map(relative =>
      createHash('md5').update(readFileSync(join(ROOT, relative.replace(/^\.\//, '')))).digest('hex'),
    );
    expect(new Set(digests).size).toBe(3);
  });

  it('ships every branding file it points at', () => {
    for (const asset of [
      'assets/icon.png',
      'assets/splash-icon.png',
      'assets/android-icon-foreground.png',
      'assets/android-icon-monochrome.png',
    ]) {
      expect(existsSync(join(ROOT, asset))).toBe(true);
    }
  });

  it('claims the three languages it speaks', () => {
    for (const profile of PROFILES) {
      expect(configs[profile].ios.infoPlist?.CFBundleLocalizations).toEqual(['en', 'ar', 'he']);
    }
  });

  it('says every permission in Arabic and Hebrew, not only English', () => {
    /*
     * The assertion that matters here.
     *
     * A purpose string is the only sentence most people ever read about what a
     * permission is for, and an untranslated one is that sentence in a language
     * they may not read — at the moment they are deciding. A new
     * `NS*UsageDescription` anywhere in the config has to appear in both files
     * or this fails.
     */
    const locales = configs.production.locales ?? {};
    expect(Object.keys(locales).sort()).toEqual(['ar', 'he']);

    const declared = new Set<string>();
    const collect = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(collect);
      if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
          if (/^NS.*UsageDescription$/.test(key)) declared.add(key);
          collect(item);
        }
      }
    };
    collect(configs.production.ios.infoPlist);
    // The speech plugin's two, which it writes at prebuild rather than into the
    // introspected config.
    declared.add('NSMicrophoneUsageDescription');
    declared.add('NSSpeechRecognitionUsageDescription');

    for (const [language, path] of Object.entries(locales)) {
      const strings = JSON.parse(readFileSync(join(ROOT, path.replace(/^\.\//, '')), 'utf8')) as Record<string, string>;
      for (const key of declared) {
        expect(`${language}:${key}:${(strings[key] ?? '').trim().length > 0}`).toBe(`${language}:${key}:true`);
      }
      // The brand is one word in Latin script everywhere.
      expect(strings.CFBundleDisplayName).toBe('MaybeSitter');
    }
  });

  it('never writes the brand with a lower-case s', () => {
    // "Maybesitter" is a different word, and it reads as a typo in the one
    // place a user cannot edit.
    for (const file of ['src/i18n/locales/en.json', 'src/i18n/locales/ar.json', 'src/i18n/locales/he.json',
      'locales/native/ar.json', 'locales/native/he.json']) {
      expect(`${file}:${readFileSync(join(ROOT, file), 'utf8').includes('Maybesitter')}`).toBe(`${file}:false`);
    }
  });
});

/**
 * Place reminders on iOS (closure CL4).
 *
 * Region monitoring with an "Always" grant. The background mode is here only
 * because expo-location's geofencing refuses to start without it (see the
 * comment on the plugin in `app.config.ts`); the purpose strings say that the
 * location stays on the phone, and there is no motion string for a sensor the
 * app never opens.
 */
describe('place reminders', () => {
  it('declares the location strings, the background mode geofencing needs, and nothing for motion', () => {
    for (const profile of PROFILES) {
      const plist = configs[profile].ios.infoPlist ?? {};
      expect(plist.UIBackgroundModes).toEqual(expect.arrayContaining(['remote-notification', 'location']));
      for (const key of [
        'NSLocationWhenInUseUsageDescription',
        'NSLocationAlwaysAndWhenInUseUsageDescription',
        'NSLocationAlwaysUsageDescription',
      ]) {
        expect(String(plist[key] ?? '')).toMatch(/stays on your phone/);
      }
      expect(plist.NSMotionUsageDescription).toBeUndefined();
    }
  });
});

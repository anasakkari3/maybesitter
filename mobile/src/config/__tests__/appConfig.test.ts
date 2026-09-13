import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';
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
    bundleIdentifier?: string;
    googleServicesFile?: string;
    config?: { usesNonExemptEncryption?: boolean };
    entitlements?: Record<string, unknown>;
    infoPlist?: Record<string, unknown>;
  };
  android: {
    package?: string;
    googleServicesFile?: string;
    allowBackup?: boolean;
    blockedPermissions?: string[];
  };
  extra?: Record<string, unknown>;
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

  it('declares the App Group the widget will read', () => {
    expect(configs.production.ios.entitlements?.['com.apple.security.application-groups']).toEqual([
      'group.com.maybesitter.app',
    ]);
  });

  it('declares Sign in with Apple, whose entitlement Expo derives (#145)', () => {
    // Declared now rather than when Apple is switched on: adding an
    // entitlement later re-provisions the whole build.
    for (const profile of PROFILES) {
      expect((configs[profile].ios as { usesAppleSignIn?: boolean }).usesAppleSignIn).toBe(true);
      expect(configs[profile].ios.entitlements?.['com.apple.developer.applesignin']).toEqual(['Default']);
    }
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
  it('never asks for a permission the stores would make us justify', () => {
    const forbidden = [
      // Play policy declarations, or outright restricted.
      'android.permission.USE_EXACT_ALARM',
      'android.permission.USE_FULL_SCREEN_INTENT',
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.QUERY_ALL_PACKAGES',
      'android.permission.MANAGE_EXTERNAL_STORAGE',
      // Background location, SMS and call log: MaybeSitter reads none of them,
      // and each is a separate Play declaration with its own review.
      'android.permission.ACCESS_BACKGROUND_LOCATION',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
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

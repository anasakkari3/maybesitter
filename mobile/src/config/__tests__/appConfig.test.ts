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
    expect(configs.production.ios.infoPlist?.CFBundleDisplayName).toBe('MaybeSitter');
    // A tester with three builds installed has to be able to tell them apart.
    expect(configs.staging.name).toBe('MaybeSitter (Staging)');
    expect(configs.development.name).toBe('MaybeSitter (Dev)');
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
      ]);
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

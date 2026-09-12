import React from 'react';
import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, sep } from 'path';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AuthProvider } from '../../../auth/AuthProvider';
import { createFakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { SettingsScreen } from '../../../screens/SettingsScreen';
import ar from '../../../i18n/locales/ar.json';
import en from '../../../i18n/locales/en.json';
import he from '../../../i18n/locales/he.json';

/**
 * What the deletion flow may contain, and what it may say.
 *
 * A deletion flow handles a password, a provider credential and a receipt id
 * in the space of a few seconds. None of it may be logged, and none of it may
 * be written anywhere — this is the one flow where the user has explicitly
 * asked for the opposite of persistence.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const ROOTS = [
  join(__dirname, '..'),
  join(__dirname, '..', '..', '..', 'screens'),
  join(__dirname, '..', '..', '..', 'api'),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' || entry === '__fixtures__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

const DELETION_SOURCES = [
  join(__dirname, '..', 'AccountDeletionProvider.tsx'),
  join(__dirname, '..', 'AccountDeletedGate.tsx'),
  join(__dirname, '..', 'reauthenticate.ts'),
  join(__dirname, '..', '..', '..', 'screens', 'DeleteAccountScreen.tsx'),
  join(__dirname, '..', '..', '..', 'screens', 'AccountDeletedScreen.tsx'),
  join(__dirname, '..', '..', '..', 'api', 'endpoints', 'account.ts'),
  join(__dirname, '..', '..', '..', 'api', 'schemas', 'account.ts'),
];

describe('nothing in the deletion flow is logged', () => {
  it('makes no console call', () => {
    const offenders = DELETION_SOURCES.filter(path => /\bconsole\.\w+\(/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('never writes the receipt or a credential to storage', () => {
    // The user asked for their data to be gone. A receipt, a password or a
    // credential on disk would be the one artefact left behind.
    const forbidden = /from '[^']*(async-storage|secure-store|expo-file-system|mmkv|expo-sqlite)[^']*'/;
    const offenders = DELETION_SOURCES.filter(path => forbidden.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps the password out of anything but the call that uses it', () => {
    const screen = readFileSync(
      join(__dirname, '..', '..', '..', 'screens', 'DeleteAccountScreen.tsx'),
      'utf8',
    );
    // It is component state and a function argument. It must not be stashed
    // in a ref, a module variable, or anything that outlives the attempt.
    expect(screen).not.toMatch(/useRef\([^)]*password/i);
    expect(screen).toMatch(/setPassword\(''\)/);
  });

  it('does not put a credential in the API layer at all', () => {
    const api = ROOTS.map(root => sourceFiles(root))
      .flat()
      .filter(path => path.includes(`${join('api')}${sep}`))
      .filter(path => /reauthenticateWith|EmailAuthProvider|identityToken/.test(readFileSync(path, 'utf8')));
    // Credentials belong to `src/auth/`, which is the only place allowed to
    // hold one (#151). The client only ever sees a bearer token.
    expect(api).toEqual([]);
  });
});

describe('the copy', () => {
  const keys = Object.keys(en).filter(key => /^(account|settingsAccount)/.test(key));

  it('exists in all three locales', () => {
    expect(keys.length).toBeGreaterThanOrEqual(30);
    for (const bundle of [ar, he] as unknown as Record<string, unknown>[]) {
      for (const key of keys) expect(typeof bundle[key]).toBe('string');
    }
  });

  it('never shows the user a developer word', () => {
    const banned = /\b(backend|exception|stack|token|firebase|uid|http|null|undefined|subjectHash)\b/i;
    // `as unknown` first: one locale key (`days`) is a list of strings, so a
    // bundle is not literally a Record<string, string>.
    const bundles = [['en', en], ['ar', ar], ['he', he]] as unknown as [string, Record<string, string>][];
    for (const [name, bundle] of bundles) {
      for (const key of keys) {
        expect({ name, key, offends: banned.test(String(bundle[key])) }).toEqual({ name, key, offends: false });
      }
    }
  });

  it('is not manipulative — no guilt, no dark pattern', () => {
    // Deliberately asserted: this is the screen where the temptation to make
    // leaving hard is strongest, and Apple's guidelines forbid it.
    const banned = /(are you sure you want to lose|you'll lose everything|we'll miss you|think again|instead of deleting)/i;
    const copy = en as unknown as Record<string, string>;
    for (const key of keys) expect(banned.test(String(copy[key]))).toBe(false);
  });

  it('says plainly that deletion is permanent', () => {
    expect(en.accountDeleteLede).toMatch(/permanent/i);
    expect(en.accountDeleteConfirmBody).toMatch(/cannot be undone/i);
  });
});

describe('the Settings entry', () => {
  async function renderSettings() {
    const repository = createFakeAuthRepository({
      initialUser: {
        uid: 'alice',
        email: 'alice@example.com',
        emailVerified: true,
        displayName: null,
        providerIds: ['password'],
      },
    });
    return render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <SettingsScreen />
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
  }

  it('shows an Account section with Delete account in it', async () => {
    await renderSettings();
    expect(screen.getByText(en.settingsAccount)).toBeTruthy();
    // Reachable from the Today tab in two taps: Settings tab, then this.
    expect(screen.getByLabelText(en.accountDelete)).toBeTruthy();
  });

  it('puts sign-out before deletion, so a thumb does not land on the wrong one', async () => {
    await renderSettings();
    const rendered = JSON.stringify(screen.toJSON());
    expect(rendered.indexOf(en.authSignOut)).toBeLessThan(rendered.indexOf(en.accountDelete));
  });

  it('shows neither to a signed-out device', async () => {
    const repository = createFakeAuthRepository({ initialUser: null });
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <AppProvider>
          <AuthProvider repository={repository} isDevBundle={false}>
            <SettingsScreen />
          </AuthProvider>
        </AppProvider>
      </SafeAreaProvider>,
    );
    expect(screen.queryByLabelText(en.accountDelete)).toBeNull();
  });
});

import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import ar from '../../i18n/locales/ar.json';
import en from '../../i18n/locales/en.json';
import he from '../../i18n/locales/he.json';

/**
 * The two rules that cannot be tested by rendering: what the source may
 * contain, and what the copy may say.
 *
 * Both closed a real defect. The pilot token was a long-lived HMAC bearer the
 * retired client pasted into a text field and kept in the keychain; nothing in
 * React Native may bring it back. And an auth screen that prints the SDK's
 * error message leaks both the address and the provider's internal codes.
 */

const SRC = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('no pilot token survives in React Native', () => {
  it('mentions neither the token, its screen nor its credential anywhere', () => {
    const offenders = sourceFiles(SRC)
      .filter(path => !path.includes('__tests__'))
      .filter(path => /pilotToken|PilotAccessScreen|PilotCredential/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('keeps no pilotAccess copy beyond the 403 states', () => {
    // UC-1.7 (#151) allows the ported `pilotAccess*` keys to serve 403 screens
    // only. There are none today; this asserts nothing crept in as sign-in copy.
    const signInKeys = Object.keys(en).filter(key => /^pilotAccess/.test(key));
    expect(signInKeys).toEqual([]);
  });
});

describe('auth modules never log a credential', () => {
  it('makes no console call at all in src/auth', () => {
    // A blanket rule rather than a careful one: "log the error but not the
    // token" is exactly the judgement call that goes wrong under pressure, and
    // there is nothing in this directory a console line would help with.
    const offenders = sourceFiles(join(SRC, 'auth'))
      .filter(path => !path.includes('__tests__'))
      .filter(path => /\bconsole\.\w+\(/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('reads the ID token in exactly one module', () => {
    const readers = sourceFiles(SRC)
      .filter(path => !path.includes('__tests__'))
      .filter(path => /@react-native-firebase\/auth/.test(readFileSync(path, 'utf8')))
      .map(path => path.slice(SRC.length + 1));
    expect(readers).toEqual(['auth/firebaseAuthRepository.ts']);
  });
});

describe('auth copy exists in all three locales', () => {
  const authKeys = Object.keys(en).filter(key => key.startsWith('auth'));

  it('covers sign-in, email, verification and every error', () => {
    expect(authKeys.length).toBeGreaterThanOrEqual(45);
    for (const bundle of [ar, he] as unknown as Record<string, string>[]) {
      for (const key of authKeys) expect(typeof bundle[key]).toBe('string');
    }
  });

  it('never shows the user a developer word', () => {
    // The #157 error-copy rule, applied to #147's copy the moment it is written
    // rather than when the client lands.
    const banned = /\b(backend|exception|stack|token|firebase|http|null|undefined)\b/i;
    for (const bundle of [en, ar, he] as unknown as Record<string, string>[]) {
      for (const key of authKeys) {
        expect({ key, banned: banned.test(String(bundle[key])) }).toEqual({ key, banned: false });
      }
    }
  });
});

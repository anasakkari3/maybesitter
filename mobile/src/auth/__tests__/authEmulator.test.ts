/**
 * The emulator override that can never ship.
 *
 * Its shape is `devBypass`'s and so are these cases, because the failure that
 * matters is the same one: an env var left in a build somebody installs. The
 * difference worth stating is what each hole is. The bearer override skips
 * authentication; this only moves where it happens — the account still signs
 * in and the server still verifies a real ID token. So the danger is not an
 * open door, it is a tester signing into a throwaway emulator account and
 * believing it is theirs.
 */
import { describe, expect, it } from '@jest/globals';
import { authEmulatorAllowed, authEmulatorUrl } from '../authEmulator';

const base = {
  isDevBundle: true,
  appEnv: 'development',
  apiBaseUrl: 'http://localhost:3000',
  host: '127.0.0.1:9099',
};

describe('the four conditions', () => {
  it('allows a development bundle whose backend is also on this machine', () => {
    expect(authEmulatorUrl(base)).toBe('http://127.0.0.1:9099');
    expect(authEmulatorUrl({ ...base, apiBaseUrl: 'http://127.0.0.1:3000' })).toBe('http://127.0.0.1:9099');
    expect(authEmulatorUrl({ ...base, host: 'localhost:9099' })).toBe('http://localhost:9099');
    // Android's loopback to the host machine, the pair `devBypass` also takes.
    expect(authEmulatorUrl({ ...base, apiBaseUrl: 'http://10.0.2.2:3000', host: '10.0.2.2:9099' }))
      .toBe('http://10.0.2.2:9099');
  });

  it('is off in a release bundle even with everything else set', () => {
    expect(authEmulatorAllowed({ ...base, isDevBundle: false })).toBe(false);
    expect(authEmulatorUrl({ ...base, isDevBundle: false })).toBeNull();
  });

  it.each(['staging', 'production', undefined, ''])('is off when APP_ENV is %s', (appEnv) => {
    expect(authEmulatorUrl({ ...base, appEnv })).toBeNull();
  });

  it('is off when the variable is unset — the emulator is opt-in, never a default', () => {
    for (const host of [undefined, null, '', '   ']) {
      expect(authEmulatorUrl({ ...base, host })).toBeNull();
    }
  });

  it('is off when the backend is not also local: an emulator against a real API is a mix, not a setup', () => {
    for (const apiBaseUrl of [
      'https://api.maybesitter.app',
      'https://staging.maybesitter.app',
      'http://192.168.1.14:3000',
      '',
      undefined,
      'not a url',
    ]) {
      expect(authEmulatorUrl({ ...base, apiBaseUrl })).toBeNull();
    }
  });
});

describe('the address itself has to be an emulator address', () => {
  it('refuses a host that is not this machine, however the variable is written', () => {
    for (const host of [
      'auth.example.com:9099',
      'https://identitytoolkit.googleapis.com:443',
      '192.168.1.14:9099',
      '10.1.2.3:9099',
    ]) {
      expect(authEmulatorUrl({ ...base, host })).toBeNull();
    }
  });

  it('requires a port: without one connectAuthEmulator would silently try 80', () => {
    expect(authEmulatorUrl({ ...base, host: '127.0.0.1' })).toBeNull();
    expect(authEmulatorUrl({ ...base, host: 'localhost' })).toBeNull();
  });

  it('refuses anything past the authority', () => {
    for (const host of ['127.0.0.1:9099/path', '127.0.0.1:9099?k=v', '127.0.0.1:9099#f']) {
      expect(authEmulatorUrl({ ...base, host })).toBeNull();
    }
  });

  it('takes the scheme off rather than doubling it', () => {
    expect(authEmulatorUrl({ ...base, host: 'http://127.0.0.1:9099' })).toBe('http://127.0.0.1:9099');
  });
});

// A Debug build crashed at launch here: `(raw ?? '').trim()` threw "undefined
// is not a function" when the configured value arrived as something other than
// a string. A value this function cannot read is not an emulator address.
describe('a value that is not a string', () => {
  it.each([9099, {}, true, ['127.0.0.1:9099']])('host %p is refused, not thrown on', (host) => {
    expect(() => authEmulatorUrl({ ...base, host: host as never })).not.toThrow();
    expect(authEmulatorUrl({ ...base, host: host as never })).toBeNull();
  });

  it.each([3000, {}, true])('apiBaseUrl %p is refused, not thrown on', (apiBaseUrl) => {
    expect(() => authEmulatorAllowed({ ...base, apiBaseUrl: apiBaseUrl as never })).not.toThrow();
    expect(authEmulatorAllowed({ ...base, apiBaseUrl: apiBaseUrl as never })).toBe(false);
  });
});


import { describe, expect, it } from '@jest/globals';
import { devBypassAllowed, devBypassToken } from '../devBypass';

// The override that can never ship. Every case below is a build that has
// actually existed at some point in a React Native project: a release bundle
// with a leftover env var, a staging build pointed at a laptop, a dev build
// pointed at production. Only the last row is allowed to sign anyone in.
const TOKEN = 'local-dev-token';

describe('dev bearer override', () => {
  const base = { isDevBundle: true, appEnv: 'development', apiBaseUrl: 'http://localhost:3000', token: TOKEN };

  it('allows a development bundle against localhost', () => {
    expect(devBypassToken(base)).toBe(TOKEN);
    expect(devBypassToken({ ...base, apiBaseUrl: 'http://127.0.0.1:3000' })).toBe(TOKEN);
    expect(devBypassToken({ ...base, apiBaseUrl: 'http://10.0.2.2:3000' })).toBe(TOKEN);
  });

  it('is off in a release bundle even with everything else set', () => {
    expect(devBypassAllowed({ ...base, isDevBundle: false })).toBe(false);
    expect(devBypassToken({ ...base, isDevBundle: false })).toBeNull();
  });

  it.each(['staging', 'production', undefined, ''])('is off when APP_ENV is %s', appEnv => {
    expect(devBypassToken({ ...base, appEnv })).toBeNull();
  });

  it('is off against any host that is not the developer machine', () => {
    for (const apiBaseUrl of [
      'https://api.maybesitter.app',
      'https://maybesitter-staging.run.app',
      'http://192.168.1.20:3000',
      'not a url',
      '',
      null,
      undefined,
    ]) {
      expect(devBypassToken({ ...base, apiBaseUrl })).toBeNull();
    }
  });

  it('is off when the token is missing or blank', () => {
    expect(devBypassToken({ ...base, token: '' })).toBeNull();
    expect(devBypassToken({ ...base, token: '   ' })).toBeNull();
    expect(devBypassToken({ ...base, token: null })).toBeNull();
  });

  it('trims the token it does return', () => {
    expect(devBypassToken({ ...base, token: `  ${TOKEN} ` })).toBe(TOKEN);
  });
});

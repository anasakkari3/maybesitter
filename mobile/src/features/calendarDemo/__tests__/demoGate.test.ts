import { afterEach, describe, expect, it } from '@jest/globals';
import { googleCalendarDemoEnabled } from '../../../config/env';
import { releaseConfigProblems } from '../../../config/releaseGuard';
import { CALENDAR_SCOPES, RESTRICTED_OR_BROADER_SCOPES } from '../scopes';

/**
 * The demo can reach exactly one person: whoever is filming it (UC-1.8 #152).
 *
 * It requests calendar scopes and writes an event. In a build anyone else
 * installs, that is a consent screen appearing unprompted and a stranger's
 * calendar being written to. Three independent gates stop that, and each one
 * is asserted separately — a single guard would be one edit away from gone.
 */

const ORIGINAL = {
  flag: process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO,
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO: ORIGINAL.flag,
    EXPO_PUBLIC_APP_ENV: ORIGINAL.appEnv,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('reaching the demo screen', () => {
  it('needs a development bundle, development APP_ENV, and the flag', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO = 'true';
    expect(googleCalendarDemoEnabled(true)).toBe(true);
  });

  it('is off in a release bundle with everything else set', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO = 'true';
    expect(googleCalendarDemoEnabled(false)).toBe(false);
  });

  it.each(['staging', 'production'])('is off when APP_ENV is %s', appEnv => {
    process.env.EXPO_PUBLIC_APP_ENV = appEnv;
    process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO = 'true';
    expect(googleCalendarDemoEnabled(true)).toBe(false);
  });

  it.each(['', 'false', '1', 'yes', undefined])('is off when the flag is %s', flag => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    if (flag === undefined) delete process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO;
    else process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO = flag;
    expect(googleCalendarDemoEnabled(true)).toBe(false);
  });
});

describe('building with the demo flag set', () => {
  it.each(['staging', 'production'] as const)('is refused for %s', appEnv => {
    // The second, independent stop: not "the screen is hidden" but "this
    // binary cannot be made". `appConfig.test.ts` proves the same thing
    // through the real `expo config` run.
    expect(
      releaseConfigProblems({
        appEnv,
        apiBaseUrl: 'https://api.example.com',
        googleCalendarDemo: 'true',
      }),
    ).toEqual(['EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO must not be set in a staging or production build']);
  });

  it('is allowed for development', () => {
    expect(
      releaseConfigProblems({ appEnv: 'development', googleCalendarDemo: 'true' }),
    ).toEqual([]);
  });
});

describe('the scopes the verification submission covers', () => {
  it('is exactly the two that were justified', () => {
    // Changing either string means a NEW Google review. A feature that needs
    // more waits for the review; it does not edit this list.
    expect(CALENDAR_SCOPES).toEqual([
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    ]);
  });

  it('asks for nothing broader, so no CASA assessment applies', () => {
    for (const scope of RESTRICTED_OR_BROADER_SCOPES) {
      expect(CALENDAR_SCOPES as readonly string[]).not.toContain(scope);
    }
  });

  it('asks for no calendar-list scope wider than the read-only one', () => {
    const listScopes = (CALENDAR_SCOPES as readonly string[]).filter(scope => scope.includes('calendarlist'));
    expect(listScopes).toEqual(['https://www.googleapis.com/auth/calendar.calendarlist.readonly']);
  });
});

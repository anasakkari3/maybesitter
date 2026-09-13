import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import {
  crashCollectionEnabled,
  initialiseCrashReporting,
  leaveBreadcrumb,
  recordError,
  safeAttributes,
  setCrashReporterForTests,
  type CrashReporter,
} from '../crash';

/**
 * What a crash report is allowed to contain (UC-4.4, #180).
 *
 * Crash data is declared "not linked to you" in the App Store label (#178,
 * #179). That declaration is only true if nothing in the app can attach an
 * identifier, so these are the tests that make it true rather than a claim.
 */

class FakeReporter implements CrashReporter {
  enabled: boolean | null = null;
  attributes: Record<string, string> = {};
  errors: Error[] = [];
  logs: string[] = [];

  async setCrashlyticsCollectionEnabled(enabled: boolean) { this.enabled = enabled; return null; }
  async setAttributes(attributes: Record<string, string>) { this.attributes = attributes; return null; }
  recordError(error: Error) { this.errors.push(error); }
  log(message: string) { this.logs.push(message); }
}

let fake: FakeReporter;
const originalEnv = process.env.EXPO_PUBLIC_APP_ENV;

beforeEach(() => {
  fake = new FakeReporter();
  setCrashReporterForTests(fake);
  process.env.EXPO_PUBLIC_APP_ENV = 'production';
});

afterEach(() => {
  setCrashReporterForTests(null);
  if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
  else process.env.EXPO_PUBLIC_APP_ENV = originalEnv;
  jest.restoreAllMocks();
});

describe('what may be attached to a report', () => {
  it('keeps the four facts about the build', () => {
    expect(safeAttributes({ app_env: 'production', api_mode: 'api', locale: 'ar', platform: 'ios' }))
      .toEqual({ app_env: 'production', api_mode: 'api', locale: 'ar', platform: 'ios' });
  });

  it('drops anything not on the allowlist', () => {
    // The failure this prevents: somebody debugging in a hurry adds `user_id`
    // or `last_capture`, and nobody reviews it.
    expect(safeAttributes({
      app_env: 'production',
      user_id: 'u-1',
      uid: 'u-1',
      email: 'a@b.c',
      last_capture: 'call the clinic at 9',
      commitment_title: 'Hand in the report',
    })).toEqual({ app_env: 'production' });
  });

  it('drops an empty or non-string value rather than sending it', () => {
    expect(safeAttributes({ app_env: '', locale: 42, platform: null })).toEqual({});
  });
});

describe('breadcrumbs', () => {
  it('leaves a named moment', () => {
    leaveBreadcrumb('capture_opened');
    expect(fake.logs).toEqual(['capture_opened']);
  });

  it('cannot leave free text', () => {
    // Names of moments, never their content. A free-text breadcrumb is where
    // somebody's commitment title ends up.
    leaveBreadcrumb('the user typed: call the clinic' as never);
    expect(fake.logs).toEqual([]);
  });
});

describe('recording an error', () => {
  it('sends the error and its context breadcrumb', () => {
    recordError(new Error('confirm failed'), 'capture_confirmed');
    expect(fake.logs).toEqual(['capture_confirmed']);
    expect(fake.errors.map((error) => error.message)).toEqual(['confirm failed']);
  });

  it('wraps a non-Error rather than dropping it', () => {
    recordError('something threw a string');
    expect(fake.errors).toHaveLength(1);
  });

  it('records nothing at all in development', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    recordError(new Error('local'), 'capture_opened');
    leaveBreadcrumb('capture_opened');
    // A developer's own crashes are noise in a dashboard measuring a closed
    // test.
    expect(fake.errors).toEqual([]);
    expect(fake.logs).toEqual([]);
    expect(crashCollectionEnabled()).toBe(false);
  });
});

describe('startup', () => {
  it('turns collection on outside development, with build facts only', async () => {
    await initialiseCrashReporting('ar', 'ios');
    expect(fake.enabled).toBe(true);
    expect(Object.keys(fake.attributes).sort()).toEqual(['api_mode', 'app_env', 'locale', 'platform']);
  });

  it('turns collection off in development, and sends nothing', async () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'development';
    await initialiseCrashReporting('ar', 'ios');
    expect(fake.enabled).toBe(false);
    expect(fake.attributes).toEqual({});
  });
});

describe('the identifier that must not exist anywhere', () => {
  /**
   * `setUserId` is what would make crash data linkable to a person, and the
   * App Store label says it is not. #180 asks for this exact grep; it is a
   * test rather than a note because the label is a legal statement.
   */
  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__tests__') continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) sourceFiles(path, found);
      else if (/\.tsx?$/.test(entry)) found.push(path);
    }
    return found;
  }

  it('is never called anywhere in the app', () => {
    const offenders = sourceFiles(join(__dirname, '..', '..'))
      // A call, not the identifier: `crash.ts` names it in the comment that
      // explains why it is absent, and a check that its own explanation trips
      // is a check somebody deletes.
      .filter((file) => /setUserId\s*\(/.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});

import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { AppProvider } from '../../../state/AppContext';
import { AboutScreen } from '../AboutScreen';
import { testCrashEnabled } from '../../../config/env';
import { releaseConfigProblems } from '../../../config/releaseGuard';
import { setCrashReporterForTests, triggerTestCrash, type CrashReporter } from '../../../lib/crash';

/**
 * The hidden test-crash trigger (UC-4.4, #180 step 8).
 *
 * Two of #180's acceptance criteria are about *symbols*: a native crash whose
 * frames are readable because the dSYM and the R8 mapping were uploaded, and a
 * JS error whose frames are readable because the Hermes source map was kept.
 * Neither can be shown without somebody deliberately crashing a release build,
 * and until this row existed there was no way to do that at all.
 *
 * The row therefore lives in staging, which is a release build a closed tester
 * installs — and must be unreachable in production. Both halves are asserted:
 * the screen hides it, and, more importantly, the *build* refuses to be made.
 */

const METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

class FakeReporter implements CrashReporter {
  crashes = 0;
  errors: Error[] = [];
  logs: string[] = [];
  async setCrashlyticsCollectionEnabled() { return null; }
  async setAttributes() { return null; }
  recordError(error: Error) { this.errors.push(error); }
  log(message: string) { this.logs.push(message); }
  crash() { this.crashes += 1; }
}

const ORIGINAL = {
  flag: process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH,
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
};

let fake: FakeReporter;

beforeEach(() => {
  fake = new FakeReporter();
  setCrashReporterForTests(fake);
});

afterEach(() => {
  setCrashReporterForTests(null);
  for (const [key, value] of Object.entries({
    EXPO_PUBLIC_ENABLE_TEST_CRASH: ORIGINAL.flag,
    EXPO_PUBLIC_APP_ENV: ORIGINAL.appEnv,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function showAbout() {
  return render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppProvider>
        <AboutScreen onBack={() => {}} />
      </AppProvider>
    </SafeAreaProvider>,
  );
}

describe('a production build cannot enable it', () => {
  it('refuses to be configured at all when the flag is set', () => {
    // The guarantee. Not "the row is hidden" — no binary that could show it
    // gets built. `appConfig.test.ts` proves the same through a real
    // `expo config` run, which is what EAS actually executes.
    expect(
      releaseConfigProblems({
        appEnv: 'production',
        apiBaseUrl: 'https://api.example.com',
        testCrash: 'true',
      }),
    ).toEqual(['EXPO_PUBLIC_ENABLE_TEST_CRASH must not be set in a production build']);
  });

  it('hides the row even in a production build that somehow exists', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'production';
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    expect(testCrashEnabled()).toBe(false);
  });

  it('does nothing if the trigger is called there anyway', () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'production';
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    triggerTestCrash('native');
    triggerTestCrash('javascript');
    expect(fake.crashes).toBe(0);
  });
});

describe('staging is where symbolication can be proven', () => {
  it('is allowed to be configured, unlike every other debug flag', () => {
    // Deliberate, and the reason the guard above says "production" rather than
    // "staging or production": a development build is not minified, has no
    // dSYM and collects nothing, so a crash from one proves nothing about
    // symbols. Staging is the only release build anybody can install today.
    expect(
      releaseConfigProblems({
        appEnv: 'staging',
        apiBaseUrl: 'https://staging.example.com',
        testCrash: 'true',
      }),
    ).toEqual([]);
  });

  it.each(['staging', 'development'])('turns the row on in %s with the flag', appEnv => {
    process.env.EXPO_PUBLIC_APP_ENV = appEnv;
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    expect(testCrashEnabled()).toBe(true);
  });

  it.each(['', 'false', '1', 'yes', undefined])('stays off when the flag is %s', flag => {
    process.env.EXPO_PUBLIC_APP_ENV = 'staging';
    if (flag === undefined) delete process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH;
    else process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = flag;
    expect(testCrashEnabled()).toBe(false);
  });
});

describe('the About screen', () => {
  it('shows no such row by default', async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH;
    process.env.EXPO_PUBLIC_APP_ENV = 'staging';
    await showAbout();
    // The default for every build anybody installs, including staging.
    expect(screen.queryByTestId('about-test-crash-native')).toBeNull();
    expect(screen.queryByTestId('about-test-crash-js')).toBeNull();
  });

  it('shows both rows when the flag is set in a staging build', async () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'staging';
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    await showAbout();
    expect(screen.queryByTestId('about-test-crash-native')).not.toBeNull();
    expect(screen.queryByTestId('about-test-crash-js')).not.toBeNull();
  });

  it('shows no row in a production build with the flag set', async () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'production';
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    await showAbout();
    expect(screen.queryByTestId('about-test-crash-native')).toBeNull();
    expect(screen.queryByTestId('about-test-crash-js')).toBeNull();
  });

  it('asks Crashlytics for a native crash when the first row is pressed', async () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'staging';
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    await showAbout();
    await fireEvent.press(screen.getByTestId('about-test-crash-native'));
    expect(fake.crashes).toBe(1);
    // A deliberate crash is not a non-fatal, and recording one as well would
    // put a second, misleading issue in the console.
    expect(fake.errors).toEqual([]);
  });

  it('throws an unhandled JS error when the second row is pressed', async () => {
    process.env.EXPO_PUBLIC_APP_ENV = 'staging';
    process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH = 'true';
    await showAbout();
    // Thrown, not recorded: the criterion is that an *unhandled* error reaches
    // Crashlytics with Hermes frames the exported source map can resolve.
    await expect(async () => {
      await fireEvent.press(screen.getByTestId('about-test-crash-js'));
    }).rejects.toThrow(/MaybeSitter test crash/);
    expect(fake.errors).toEqual([]);
  });
});

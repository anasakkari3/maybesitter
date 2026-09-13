import React from 'react';
import { Text } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { changeLanguage } from 'i18next';
import { ErrorBoundary } from '../ErrorBoundary';
import { setCrashReporterForTests, type CrashReporter } from '../../lib/crash';
import { palettes } from '../../theme/tokens';
import en from '../../i18n/locales/en.json';
import ar from '../../i18n/locales/ar.json';

/**
 * The app-wide boundary (UC-4.4, #180 step 4).
 *
 * Three things have to be true at once, and each is a separate failure:
 *
 *  - the error reaches Crashlytics. A boundary that only renders a fallback
 *    turns a reported crash into a silent one, which is strictly worse than
 *    no boundary: the app looks fine and the dashboard says it is.
 *  - the message reaches nobody else. Not the screen, not a log.
 *  - "try again" actually tries again, rather than sitting on a dead button.
 */

/** The secret: it must appear in the report and in nothing else. */
const MESSAGE = 'confirm() exploded at line 41 for user u-77';

/**
 * A child that throws on render until the *test* turns it off.
 *
 * A class, and the flag is a static that only the test body writes: a function
 * component may not write to a variable declared outside it (React Compiler),
 * and driving this through a pressable is impossible because the component
 * that would hold the button is the one that throws.
 */
class Boom extends React.Component {
  static shouldThrow = true;
  override render(): React.ReactNode {
    if (Boom.shouldThrow) throw new Error(MESSAGE);
    return <Text testID="recovered">recovered</Text>;
  }
}

class FakeReporter implements CrashReporter {
  errors: Error[] = [];
  logs: string[] = [];
  crashes = 0;
  async setCrashlyticsCollectionEnabled() { return null; }
  async setAttributes() { return null; }
  recordError(error: Error) { this.errors.push(error); }
  log(message: string) { this.logs.push(message); }
  crash() { this.crashes += 1; }
}

let fake: FakeReporter;
const originalEnv = process.env.EXPO_PUBLIC_APP_ENV;

beforeEach(() => {
  Boom.shouldThrow = true;
  fake = new FakeReporter();
  setCrashReporterForTests(fake);
  // Collection is off in development, so a boundary test run there would
  // assert nothing at all.
  process.env.EXPO_PUBLIC_APP_ENV = 'production';
  // React logs a caught error itself in a development bundle. That is React's,
  // not ours — the grep below is what proves this module adds none.
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  Boom.shouldThrow = false;
  setCrashReporterForTests(null);
  if (originalEnv === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
  else process.env.EXPO_PUBLIC_APP_ENV = originalEnv;
  await changeLanguage('ar');
  jest.restoreAllMocks();
});

describe('a render error', () => {
  it('is reported to Crashlytics, with a breadcrumb and no invention', async () => {
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    // The assertion this file exists for: the error object itself reached the
    // reporter, not merely that something rendered.
    expect(fake.errors.map(error => error.message)).toEqual([MESSAGE]);
    expect(fake.logs).toEqual(['render_failed']);
  });

  it('shows the calm screen instead of a blank one', async () => {
    await changeLanguage('en');
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByTestId('crash-title').props.children).toBe(en.crashTitle);
    expect(screen.getByTestId('crash-body').props.children).toBe(en.crashBody);
    expect(screen.queryByTestId('crash-retry')).not.toBeNull();
  });

  it('tells the person nothing about the error', async () => {
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    // Not the message, not the stack, not a fragment of either.
    expect(screen.queryByText(MESSAGE)).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain('exploded');
    expect(JSON.stringify(screen.toJSON())).not.toContain('u-77');
  });

  it('logs nothing of its own, in any build', () => {
    // A console line in a release build is that same text in the device log,
    // sitting next to whatever else was on screen.
    const source = readFileSync(join(__dirname, '..', 'ErrorBoundary.tsx'), 'utf8');
    expect(source).not.toMatch(/console\s*\.\s*\w+\s*\(/);
  });
});

describe('the way back in', () => {
  it('re-renders the children when the screen is retried', async () => {
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.queryByTestId('crash-fallback')).not.toBeNull();

    Boom.shouldThrow = false;
    await fireEvent.press(screen.getByTestId('crash-retry'));

    expect(screen.queryByTestId('crash-fallback')).toBeNull();
    expect(screen.queryByTestId('recovered')).not.toBeNull();
  });

  it('shows the screen again if the retry fails too, rather than blanking', async () => {
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    await fireEvent.press(screen.getByTestId('crash-retry'));
    expect(screen.queryByTestId('crash-fallback')).not.toBeNull();
    // Reported both times: a repeat is a different fact from a one-off.
    expect(fake.errors).toHaveLength(2);
  });
});

describe('the screen the person actually reads', () => {
  it('speaks the language the app was in, outside every provider', async () => {
    // The boundary sits above AppProvider, so it cannot ask it anything. It
    // reads i18next, which is where the language the app was rendering lives.
    await changeLanguage('ar');
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByTestId('crash-title').props.children).toBe(ar.crashTitle);
    expect(screen.getByTestId('crash-fallback').props.style.direction).toBe('rtl');
  });

  it('is not red, and does not invent a colour', async () => {
    // The design has no danger role at all (mobile/AGENTS.md). Every colour on
    // this screen comes from the token palette.
    await changeLanguage('en');
    await render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByTestId('crash-fallback').props.style.backgroundColor).toBe(palettes.light.bg);
    expect(screen.getByTestId('crash-retry').props.style.backgroundColor).toBe(palettes.light.ac);
  });
});

describe('reporting is not allowed to become the failure', () => {
  it('still shows the screen when the reporter throws', async () => {
    await render(
      <ErrorBoundary onError={() => { throw new Error('crashlytics is down'); }}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.queryByTestId('crash-fallback')).not.toBeNull();
  });
});

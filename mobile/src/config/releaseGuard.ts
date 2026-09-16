/**
 * The one rule that decides whether a build's backend configuration is safe.
 *
 * The retired Flutter client shipped a release build that quietly fell back to
 * `http://localhost:3000`, so a TestFlight tester's app talked to nothing (or
 * worse, to whatever listened on their network). The lesson kept here: fail at
 * build time, and test the real resolution rather than a copy of it.
 *
 * `app.config.ts` calls this while Expo reads the project — before any native
 * compile — and `env.ts` calls the same function at runtime, so the build rule
 * and the runtime rule cannot drift apart.
 *
 * No React Native imports: `app.config.ts` runs in plain Node.
 */

export type AppEnv = 'development' | 'staging' | 'production';

export interface ReleaseConfigInput {
  appEnv?: string | undefined;
  apiBaseUrl?: string | undefined;
  devBearerToken?: string | undefined;
  /**
   * `EXPO_PUBLIC_API_MODE`. `mock` serves the committed contract fixtures
   * instead of the server, which is useful for UI work and catastrophic in a
   * build a tester installs: they would confirm commitments into nothing and
   * believe they were saved (UC-1.4 #148 step 4).
   */
  apiMode?: string | undefined;
  /**
   * `EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO`. The Google Calendar
   * verification demo (UC-1.8 #152) requests calendar scopes and writes a test
   * event. It exists to be filmed for a reviewer and must never be reachable
   * in a build anyone else installs.
   */
  googleCalendarDemo?: string | undefined;
  /**
   * `EXPO_PUBLIC_ENABLE_TEST_CRASH`. The hidden row on the About screen that
   * crashes the app on purpose (UC-4.4 #180 step 8).
   *
   * Unlike every other flag here it is allowed in **staging**, and that is the
   * point rather than an oversight: the two symbolication criteria can only be
   * shown on a release build — minified, obfuscated, with a dSYM and a mapping
   * uploaded — and staging is the only release build anybody can install
   * before the store accounts exist. A development build proves nothing, since
   * collection is off there and nothing is minified.
   *
   * Production is a different question. A row that crashes the app is not a
   * thing a real user may ever find, so a production build that sets this does
   * not get made.
   */
  testCrash?: string | undefined;
  /**
   * `EXPO_PUBLIC_FEATURE_SHARE_INTAKE` (UC-3.0, #183).
   *
   * Allowed in every environment — share intake is a launch feature and will be
   * on in production — but only ever spelled `true` or `false`. A typo here is
   * the quiet kind of wrong: `EXPO_PUBLIC_FEATURE_SHARE_INTAKE=1` reads as off,
   * the share sheet still offers MaybeSitter because the native target is
   * compiled in either way, and every tester who uses it gets the "not yet"
   * notice while the build log says the feature was enabled.
   */
  shareIntake?: string | undefined;
  /**
   * `EXPO_PUBLIC_FEATURE_CALENDAR_WRITE` (UC-3.1, #185).
   *
   * Allowed in every environment — writing commitments to the phone's calendar
   * is a launch feature — but only ever spelled `true` or `false`. The same
   * quiet failure as `shareIntake`: a typo reads as off, the calendar
   * permission is still compiled into the binary so the prompt can still
   * appear, and every tester who turns the toggle on watches nothing happen
   * while the build log says the feature was enabled.
   */
  calendarWrite?: string | undefined;
  /**
   * `EXPO_PUBLIC_FEATURE_CALENDAR_READ` (UC-3.2, #186).
   *
   * Checked for the same reason as the others, and it matters more here because
   * this one is a *kill switch*: `calendarReadEnabled` treats anything but the
   * literal `false` as on, so a typo leaves busy-time reading enabled on a
   * build somebody meant to disable it on. The build refuses instead.
   */
  calendarRead?: string | undefined;
  /**
   * `EXPO_PUBLIC_SHARE_INTENT_DEBUG` (UC-3.0, #183).
   *
   * Turns on `expo-share-intent`'s own logging, which writes the shared payload
   * — the text, the file paths — to the device log. A build anybody else
   * installs must not be able to do that, so a staging or production build that
   * sets it at all does not get made. The same shape as the Google Calendar
   * demo flag above, for the same reason.
   */
  shareIntentDebug?: string | undefined;
}

export const APP_ENVS: readonly AppEnv[] = ['development', 'staging', 'production'];

/** Hosts that only ever mean "a machine on the developer's desk". */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '10.0.2.2', '10.0.3.2']);

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local
  return false;
}

/**
 * Problems that must stop a staging or production build. An empty array means
 * the configuration is safe to ship.
 */
export function releaseConfigProblems(input: ReleaseConfigInput): string[] {
  const problems: string[] = [];
  const appEnv = (input.appEnv ?? '').trim();

  if (!APP_ENVS.includes(appEnv as AppEnv)) {
    return [`APP_ENV must be one of ${APP_ENVS.join(', ')} (got ${appEnv === '' ? '<empty>' : appEnv})`];
  }
  const apiMode = (input.apiMode ?? '').trim();
  if (apiMode !== '' && apiMode !== 'api' && apiMode !== 'mock') {
    problems.push(`EXPO_PUBLIC_API_MODE must be api or mock (got ${apiMode})`);
  }

  if (appEnv === 'production' && (input.testCrash ?? '').trim() !== '') {
    problems.push('EXPO_PUBLIC_ENABLE_TEST_CRASH must not be set in a production build');
  }

  // Checked in every environment, development included: a value that is neither
  // `true` nor `false` is a mistake wherever it is made, and the development
  // build is where somebody would find out cheaply.
  const shareIntake = (input.shareIntake ?? '').trim();
  if (shareIntake !== '' && shareIntake !== 'true' && shareIntake !== 'false') {
    problems.push(`EXPO_PUBLIC_FEATURE_SHARE_INTAKE must be true or false (got ${shareIntake})`);
  }

  const calendarRead = (input.calendarRead ?? '').trim();
  if (calendarRead !== '' && calendarRead !== 'true' && calendarRead !== 'false') {
    problems.push(`EXPO_PUBLIC_FEATURE_CALENDAR_READ must be true or false (got ${calendarRead})`);
  }

  const calendarWrite = (input.calendarWrite ?? '').trim();
  if (calendarWrite !== '' && calendarWrite !== 'true' && calendarWrite !== 'false') {
    problems.push(`EXPO_PUBLIC_FEATURE_CALENDAR_WRITE must be true or false (got ${calendarWrite})`);
  }

  // A developer build is allowed to point at a laptop, and to run on fixtures.
  if (appEnv === 'development') return problems;

  if (apiMode === 'mock') {
    problems.push('EXPO_PUBLIC_API_MODE=mock must not be set in a staging or production build');
  }

  if ((input.googleCalendarDemo ?? '').trim() !== '') {
    problems.push(
      'EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO must not be set in a staging or production build',
    );
  }

  // The share payload in the device log. Never in a build somebody installs.
  if ((input.shareIntentDebug ?? '').trim() !== '') {
    problems.push(
      'EXPO_PUBLIC_SHARE_INTENT_DEBUG must not be set in a staging or production build',
    );
  }

  const raw = (input.apiBaseUrl ?? '').trim();
  if (raw === '') {
    problems.push('EXPO_PUBLIC_API_BASE_URL is empty');
  } else {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      problems.push(`EXPO_PUBLIC_API_BASE_URL is not a valid URL (${raw})`);
    }
    if (url) {
      if (url.protocol !== 'https:') {
        problems.push(`EXPO_PUBLIC_API_BASE_URL must use https (got ${url.protocol.replace(':', '')})`);
      }
      const hostname = url.hostname.toLowerCase();
      if (
        LOCAL_HOSTNAMES.has(hostname) ||
        hostname.endsWith('.local') ||
        hostname.endsWith('.localhost') ||
        hostname.endsWith('.invalid') ||
        hostname.endsWith('.test') ||
        hostname.endsWith('.example') ||
        isPrivateIPv4(hostname)
      ) {
        problems.push(`EXPO_PUBLIC_API_BASE_URL points at a local or private host (${hostname})`);
      }
    }
  }

  if ((input.devBearerToken ?? '').trim() !== '') {
    problems.push('EXPO_PUBLIC_DEV_BEARER_TOKEN must not be set in a staging or production build');
  }

  return problems;
}

/** The message shown in a build log and on the misconfigured screen. */
export function releaseConfigErrorMessage(problems: readonly string[]): string {
  return `CFG-1 release config: ${problems.join('; ')}`;
}

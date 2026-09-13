import Constants from 'expo-constants';
import { APP_ENVS, releaseConfigProblems, type AppEnv } from './releaseGuard';

/**
 * The app's view of its own configuration.
 *
 * It runs the same `releaseConfigProblems` rule the build ran (app.config.ts),
 * so the two can never drift. A build that slipped through — an old binary, a
 * hand-patched bundle — renders the misconfigured screen instead of talking to
 * whatever host it was handed.
 */

type Extra = {
  appEnv?: string;
  apiBaseUrl?: string | null;
  googleWebClientId?: string | null;
  apiMode?: string | null;
};

function extra(): Extra {
  return (Constants.expoConfig?.extra ?? {}) as Extra;
}

export function appEnv(): AppEnv {
  const value = process.env.EXPO_PUBLIC_APP_ENV ?? extra().appEnv ?? 'development';
  return (APP_ENVS as readonly string[]).includes(value) ? (value as AppEnv) : 'development';
}

export function apiBaseUrl(): string | null {
  return process.env.EXPO_PUBLIC_API_BASE_URL ?? extra().apiBaseUrl ?? null;
}

/**
 * `mock` serves the committed contract fixtures instead of the server. It is
 * only ever honoured in a development build — `releaseConfigProblems` refuses
 * to configure a staging or production app that asks for it, so a tester can
 * never be shown fixture data they believe is theirs.
 */
export function apiMode(): 'api' | 'mock' {
  const raw = (process.env.EXPO_PUBLIC_API_MODE ?? extra().apiMode ?? 'api').trim();
  return raw === 'mock' && isDevelopment() ? 'mock' : 'api';
}

/** Empty when this build is safe to use. */
export function configProblems(): string[] {
  return releaseConfigProblems({
    appEnv: process.env.EXPO_PUBLIC_APP_ENV ?? extra().appEnv,
    apiBaseUrl: apiBaseUrl() ?? undefined,
    devBearerToken: process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN,
    apiMode: process.env.EXPO_PUBLIC_API_MODE ?? extra().apiMode ?? undefined,
    googleCalendarDemo: process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO,
    testCrash: process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH,
  });
}

export function isDevelopment(): boolean {
  return appEnv() === 'development';
}

/**
 * The local sign-in override's token (UC-1.7 #151), or null.
 *
 * Reading it here is not the same as honouring it: `src/auth/devBypass.ts`
 * decides that, and `releaseConfigProblems` above already refuses to *build*
 * a staging or production app with the variable set.
 */
export function devBearerToken(): string | null {
  const raw = (process.env.EXPO_PUBLIC_DEV_BEARER_TOKEN ?? '').trim();
  return raw === '' ? null : raw;
}

/**
 * The root of the published legal site (UC-4.2 #177), or null.
 *
 * One variable rather than six. `site/` already publishes
 * `/{en,ar,he}/{privacy,terms}` with `cleanUrls`, so the locale and the page
 * are a path this app can build — and adding a language later becomes a
 * translation, not a deploy variable.
 *
 * Null until OWNER-A1 (#137) buys the domain and publishes. Every caller then
 * renders nothing rather than a link that 404s, which matters most on the
 * sign-in screen: it is the one page a new user judges the product on.
 * **Nothing here invents a domain.**
 *
 * A trailing slash is stripped so `${base}/en/privacy` cannot become a double
 * slash, which some hosts 404 and others redirect.
 */
export function legalBaseUrl(): string | null {
  const base = httpsUrlOrNull(process.env.EXPO_PUBLIC_LEGAL_BASE_URL);
  return base === null ? null : base.replace(/\/+$/, '');
}

/**
 * The privacy policy and terms URLs, from the build's environment.
 *
 * Superseded by `legalBaseUrl` and kept for the two variables that already
 * exist in the EAS configuration: a build that sets them keeps working, and a
 * build that sets the base URL gets locale-correct pages. `src/config/
 * legalLinks.ts` is what screens should call; this is the raw reading.
 */
export function legalUrls(): { privacy: string | null; terms: string | null } {
  return {
    privacy: httpsUrlOrNull(process.env.EXPO_PUBLIC_PRIVACY_URL),
    terms: httpsUrlOrNull(process.env.EXPO_PUBLIC_TERMS_URL),
  };
}

function httpsUrlOrNull(value: string | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * The Google Web OAuth client id (UC-1.2 #146), or null.
 *
 * `app.config.ts` takes it from the committed `firebase/google-services.json`
 * at build time. Null means this build cannot offer Google sign-in, and the
 * button is hidden rather than shown and then failing with `DEVELOPER_ERROR`.
 */
export function googleWebClientId(): string | null {
  const override = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();
  if (override !== '') return override;
  const value = extra().googleWebClientId;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Whether this build offers Sign in with Apple (UC-1.1 #145).
 *
 * Off by default. The code is complete for iOS, but it cannot work until the
 * owner has enabled the capability on the App ID `com.maybesitter.app` and
 * filled the Apple provider (Services ID, Team ID, Key ID, private key) into
 * the Firebase console. Until then the button is hidden rather than shown and
 * failing — the flag is the switch that turns it on with no code change.
 */
export function appleSignInEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_APPLE_SIGN_IN_ENABLED ?? '').trim() === 'true';
}

/**
 * Whether dictation is offered (UC-2.3, #163).
 *
 * On by default, and switched off by `EXPO_PUBLIC_KILL_SWITCH_VOICE=true`.
 *
 * A kill switch rather than an enable flag, because the failure it exists for
 * is a recogniser behaving badly for real users — and in that moment the thing
 * that must be one variable away is *off*. A feature that has to be turned on
 * to be tested is also a feature nobody tests.
 *
 * The mic hides itself when there is no recogniser regardless; this is the
 * operator's switch, not the device's.
 */
export function voiceEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_KILL_SWITCH_VOICE ?? '').trim() !== 'true';
}

/**
 * Whether the Google Calendar verification demo is reachable (UC-1.8 #152).
 *
 * Three conditions, all required: a development bundle, `APP_ENV=development`,
 * and the variable set to `true` in a developer's own `.env.local`. It is
 * never an EAS variable, and `releaseConfigProblems` refuses to *configure* a
 * staging or production build that sets it at all — so the demo cannot reach
 * anyone but the person filming it.
 */
export function googleCalendarDemoEnabled(isDevBundle: boolean = __DEV__): boolean {
  if (isDevBundle !== true) return false;
  if (!isDevelopment()) return false;
  return (process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO ?? '').trim() === 'true';
}

/**
 * The public account-deletion policy page (UC-4.2 #177, on OWNER-A1 #137's
 * domain), or null.
 *
 * Null until the site exists. The deletion screen then renders no link rather
 * than one that 404s on the screen where the user most needs to trust us.
 * Nothing here invents a URL.
 */
export function accountDeletionUrl(): string | null {
  return httpsUrlOrNull(process.env.EXPO_PUBLIC_ACCOUNT_DELETION_URL);
}

/**
 * Whether the hidden test-crash row is on the About screen (UC-4.4 #180 step 8).
 *
 * Two conditions: the build is not production, and the variable is set to
 * `true`. Deliberately *not* the `googleCalendarDemoEnabled` shape above —
 * that one additionally demands a development bundle, and a development bundle
 * is exactly where a test crash is worthless. Collection is off in development
 * (`crashCollectionEnabled`), nothing is minified, and there is no dSYM or R8
 * mapping to symbolicate against; a crash from there proves nothing about the
 * two criteria the row exists to satisfy.
 *
 * So it is reachable in staging — a release build, internally distributed,
 * built the way production is — and never in production. The production half
 * is not enforced here: `releaseConfigProblems` refuses to *configure* a
 * production build with the variable set at all, so the binary is never made.
 * This is the second lock on the same door, for a build that somehow exists.
 */
export function testCrashEnabled(): boolean {
  if (appEnv() === 'production') return false;
  return (process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH ?? '').trim() === 'true';
}

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
  firebaseAuthEmulatorHost?: string | null;
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

/** `EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` — see `auth/authEmulator.ts`. */
export function firebaseAuthEmulatorHost(): string | null {
  return process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST ?? extra().firebaseAuthEmulatorHost ?? null;
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
    firebaseAuthEmulatorHost: process.env.EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST,
    apiMode: process.env.EXPO_PUBLIC_API_MODE ?? extra().apiMode ?? undefined,
    googleCalendarDemo: process.env.EXPO_PUBLIC_ENABLE_GOOGLE_CALENDAR_DEMO,
    testCrash: process.env.EXPO_PUBLIC_ENABLE_TEST_CRASH,
    shareIntake: process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE,
    shareIntentDebug: process.env.EXPO_PUBLIC_SHARE_INTENT_DEBUG,
    calendarWrite: process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE,
    calendarRead: process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ,
    icsFeeds: process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS,
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

/**
 * Whether this build may edit a commitment in place (UC-2.R3, #173).
 *
 * On by default, and switched off by
 * `EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH=false`.
 *
 * ── Why the client and not the route ─────────────────────────────
 *
 * The criterion is "with `features.safeCommitmentPatch=false`, no PATCH is
 * ever sent", and *sent* is a fact about this app. A 404 from the route would
 * be a different guarantee — the request would still leave the phone, over a
 * connection the user is paying for, carrying the title they just typed. So the
 * gate sits at the one place every PATCH is built, `usePatchCommitment`, and
 * `DetailsScreen` additionally hides the Edit control when it is off, the way
 * `appleSignInEnabled` hides a button rather than shipping one that fails.
 *
 * The route is deliberately left open. `PATCH /api/mobile/commitments/:id` is
 * not a module in `runtimeControls`' sense — it is the write half of a resource
 * whose `GET` and `If-Match` conflict handling this app depends on — and a
 * 404 on the write of a resource that still reads is a contract this client
 * would have to special-case everywhere.
 *
 * Read like a kill switch and named like the criterion: the value that turns it
 * off is the literal string `false`, so an unset variable, an empty one, or a
 * typo leaves editing on rather than silently disabling it.
 */
export function safeCommitmentPatchEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_SAFE_COMMITMENT_PATCH ?? '').trim() !== 'false';
}

/**
 * Whether this build may write to the phone's calendar (UC-3.1, #185 step 8).
 *
 * **Off by default**, and turned on by `EXPO_PUBLIC_FEATURE_CALENDAR_WRITE=true`.
 * An enable flag rather than a kill switch, like share intake and for the same
 * reason: what is gated is not a feature that already works for real users. It
 * writes into somebody's calendar — a place they share with other people — and
 * none of its acceptance criteria can be proven without a device with seeded
 * calendars. The state it must default to is off until QA has a device run.
 *
 * ── Why the app and not the route ────────────────────────────────
 *
 * There is no route to gate. The write happens on the device, through EventKit
 * and the Android provider, and the server sees only the link afterwards. So
 * this is the only lock there is, and it sits in `useDeviceCalendarSync` — the
 * one place a calendar pass is started — rather than on the settings screen. A
 * hidden toggle is a fact about one screen; this is a claim the code keeps
 * however the sync is reached.
 *
 * Read like the other enable flags: the literal string `true` and nothing else,
 * so an empty value or a typo leaves it off.
 */
export function calendarWriteEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_CALENDAR_WRITE ?? '').trim() === 'true';
}

/**
 * Whether this build shows subscribed calendar feeds (UC-3.4, #188).
 *
 * **Off by default**, on only for `EXPO_PUBLIC_FEATURE_ICS_FEEDS=true` — the
 * mirror of the server's `ICS_FEEDS_ENABLED`, which is also an enable flag and
 * also off by default. The two are separate on purpose: a build with the
 * screen and a server without the routes gets a 404 it renders as "not
 * available", and the server can be switched off without shipping a binary.
 *
 * The entry point, the screen and every feed query check it, so a hidden row
 * is not the only thing standing between a build that should not have this and
 * a request to the routes.
 */
export function icsFeedsEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_ICS_FEEDS ?? '').trim() === 'true';
}

/**
 * Whether this build reads busy time out of the phone's calendar
 * (UC-3.2, #186 step 9).
 *
 * **On by default**, and turned off by `EXPO_PUBLIC_FEATURE_CALENDAR_READ=false`
 * — the opposite default from `calendarWriteEnabled` above, and the difference
 * is the point. Writing puts an entry into a place somebody shares with other
 * people; reading puts nothing anywhere that the user has not already seen, and
 * it cannot happen at all until they turn the calendar switch on and the OS
 * agrees. So the thing that needs a device run before it is trusted is the
 * write, and this is a kill switch rather than a launch gate.
 *
 * Read as "anything but the literal string `false`", so a typo leaves the
 * feature on — again the mirror of the enable flags, because for a kill switch
 * the dangerous typo is the one that silently disables.
 */
export function calendarReadEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_CALENDAR_READ ?? '').trim() !== 'false';
}

/**
 * Whether this build accepts a share (UC-3.0, #183 step 10).
 *
 * **Off by default**, and turned on by `EXPO_PUBLIC_FEATURE_SHARE_INTAKE=true`.
 * An enable flag rather than a kill switch — the opposite of `voiceEnabled` —
 * because the thing being gated is not a feature that already works for real
 * users. It is a new ingress that needs a native share target, a backend flag
 * and four channels that do not exist yet; the state it must default to is off.
 *
 * ── Why the app and not only the route ───────────────────────────
 *
 * `SHARE_INTAKE_ENABLED` on the server answers 404 when it is off, and that is
 * the outer lock. This is the inner one, and it is what makes the criterion
 * "with the flags off the app shows the notice" true without a round trip: a
 * share opens the screen, the screen sees the flag is off and shows the notice,
 * and the bytes never leave the phone. Asking the server first would upload
 * somebody's screenshot to learn that the feature is switched off.
 *
 * Read like the other enable flags: the literal string `true` and nothing else,
 * so an empty value or a typo leaves it off.
 */
export function shareIntakeEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_SHARE_INTAKE ?? '').trim() === 'true';
}

/**
 * Whether `expo-share-intent` logs what it received (UC-3.0, #183).
 *
 * Its `debug` option `console.debug`s the whole shared payload — the text, the
 * file paths, the parsed intent — into the device log, where any other process
 * on the phone can read it. That is the exact failure `src/api/`'s no-logging
 * rule exists for, on the most sensitive content this product has ever handled,
 * so it is a development-only switch twice over: it needs a development bundle
 * *and* the variable, and `releaseConfigProblems` refuses to **configure** a
 * staging or production build that sets it at all.
 */
export function shareIntentDebugEnabled(isDevBundle: boolean = __DEV__): boolean {
  if (isDevBundle !== true) return false;
  if (!isDevelopment()) return false;
  return (process.env.EXPO_PUBLIC_SHARE_INTENT_DEBUG ?? '').trim() === 'true';
}

/**
 * Gentle reminders (UC-3.11, #196).
 *
 * On by default, and switched off by `EXPO_PUBLIC_FEATURE_SOFT_REMINDERS=false`
 * — the same shape as `safeCommitmentPatchEnabled` above, and for the same
 * reason: a kill switch that has to be *set* to be safe is a kill switch
 * somebody forgets to set.
 *
 * Off does not mean "schedule nothing from now on". It means the app cancels
 * everything it already has pending, because a reminder scheduled yesterday
 * fires whether or not today's build would have scheduled it — see
 * `cancelEveryReminder`.
 */
export function softRemindersEnabled(): boolean {
  return (process.env.EXPO_PUBLIC_FEATURE_SOFT_REMINDERS ?? '').trim() !== 'false';
}

/**
 * The version string the device registry stores (UC-3.0b, #184).
 *
 * From the running binary when there is one, and from the config otherwise, so
 * a value is always available under Jest. It is the only thing about the
 * device this app reports beyond the platform — no model, no OS build.
 */
export function appVersion(): string {
  const native = Constants.expoConfig?.version;
  return typeof native === 'string' && native.trim() !== '' ? native.trim() : '0.0.0';
}

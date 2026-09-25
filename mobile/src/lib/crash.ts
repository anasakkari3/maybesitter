import {
  crash as crashlyticsCrash,
  getCrashlytics,
  log as crashlyticsLog,
  recordError as crashlyticsRecordError,
  setAttributes as crashlyticsSetAttributes,
  setCrashlyticsCollectionEnabled,
} from '@react-native-firebase/crashlytics';
import { appEnv, apiMode, testCrashEnabled } from '../config/env';

/**
 * The only module that talks to Crashlytics (UC-4.4, #180).
 *
 * ── What a crash report may contain ──────────────────────────────
 *
 * A stack trace, and a handful of facts about the *build*. Nothing about the
 * person: no user id, no capture text, no transcript, no commitment title, no
 * calendar data. Crash data is declared "not linked to you" in the App Store
 * label (#178, #179), and that declaration is only true if nothing here can
 * carry an identifier.
 *
 * So this is not a thin wrapper. It is the enforcement point:
 *
 *   - `setUserId` is never called, and a test greps the whole app for it.
 *   - attributes go through an allowlist of keys, and anything else is dropped
 *     rather than sent.
 *   - `log` takes a fixed set of breadcrumb names, not free text. A free-text
 *     breadcrumb is where somebody's commitment title ends up six months from
 *     now, added by someone debugging in a hurry and reviewed by nobody.
 *   - an `Error`'s `message` is sent, because a stack with no message is not
 *     worth collecting — and errors in this app are constructed from fixed
 *     strings. `userFacingMessage` never interpolates one either (#157).
 *
 * ── Off in development ───────────────────────────────────────────
 *
 * A developer's own crashes are noise in a dashboard measuring a closed test,
 * and their laptop is not a tester's phone.
 */

/** The only attribute keys that may be attached to a report. */
const ALLOWED_ATTRIBUTES = ['app_env', 'api_mode', 'locale', 'platform'] as const;
export type CrashAttribute = (typeof ALLOWED_ATTRIBUTES)[number];

/**
 * The only breadcrumbs the app may leave.
 *
 * Names of moments, never their content. "The user opened capture" is a fact
 * about the app; what they typed there is not ours to put in a crash log.
 */
const BREADCRUMBS = [
  'capture_opened',
  'capture_analyzed',
  'capture_confirmed',
  'next_step_shown',
  'next_step_decided',
  'sign_in_started',
  'sign_out',
  /**
   * The app-wide ErrorBoundary caught a render error and showed the retry
   * screen (#180 step 4). A fact about the app, like every other name here —
   * what was on screen when it happened is not ours to put in a crash log.
   */
  'render_failed',
  /**
   * Revoking a Sign in with Apple account's tokens before deletion did not
   * land (App Store rule 5.1.1(v)). The deletion went ahead regardless; this
   * is how an operator learns the Firebase Apple provider needs attention.
   * Never the code, never the SDK's message — only that it happened.
   */
  'apple_revocation_failed',
] as const;
export type CrashBreadcrumb = (typeof BREADCRUMBS)[number];

export interface CrashReporter {
  setCrashlyticsCollectionEnabled(enabled: boolean): Promise<unknown>;
  setAttributes(attributes: Record<string, string>): Promise<unknown>;
  recordError(error: Error, jsErrorName?: string): void;
  log(message: string): void;
  /** Only ever reached through `triggerTestCrash` below. */
  crash(): void;
}

let reporter: CrashReporter | null = null;

/** Swapped in tests. Production resolves the real client lazily. */
export function setCrashReporterForTests(next: CrashReporter | null): void {
  reporter = next;
}

function client(): CrashReporter | null {
  if (reporter) return reporter;
  try {
    const instance = getCrashlytics();
    reporter = {
      setCrashlyticsCollectionEnabled: (enabled) => setCrashlyticsCollectionEnabled(instance, enabled),
      setAttributes: (attributes) => crashlyticsSetAttributes(instance, attributes),
      recordError: (error, jsErrorName) => crashlyticsRecordError(instance, error, jsErrorName),
      log: (message) => crashlyticsLog(instance, message),
      crash: () => crashlyticsCrash(instance),
    };
    return reporter;
  } catch {
    // No native module — a Jest run, or a build without the plugin. Crash
    // reporting is not worth failing an app launch over.
    return null;
  }
}

/** Whether reports are collected at all. Off on a developer's own machine. */
export function crashCollectionEnabled(): boolean {
  return appEnv() !== 'development';
}

export async function initialiseCrashReporting(locale: string, platform: string): Promise<void> {
  const target = client();
  if (!target) return;
  try {
    await target.setCrashlyticsCollectionEnabled(crashCollectionEnabled());
    if (!crashCollectionEnabled()) return;
    await target.setAttributes(safeAttributes({
      app_env: appEnv(),
      api_mode: apiMode(),
      locale,
      platform,
    }));
  } catch {
    // A reporter that cannot start is not a reason the app cannot.
  }
}

/**
 * The attributes that survive the allowlist.
 *
 * Exported so a test can assert the filtering directly rather than through the
 * SDK: the rule is the point, not the call.
 */
export function safeAttributes(input: Record<string, unknown>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of ALLOWED_ATTRIBUTES) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) safe[key] = value;
  }
  return safe;
}

/** A named moment. Anything not on the list is dropped, not sent. */
export function leaveBreadcrumb(name: CrashBreadcrumb): void {
  if (!crashCollectionEnabled()) return;
  if (!(BREADCRUMBS as readonly string[]).includes(name)) return;
  client()?.log(name);
}

/**
 * Records a non-fatal.
 *
 * `context` is a breadcrumb name, not a sentence: it says where the failure
 * happened and nothing about what the person was doing there.
 */
export function recordError(error: unknown, context?: CrashBreadcrumb): void {
  if (!crashCollectionEnabled()) return;
  const target = client();
  if (!target) return;
  if (context) leaveBreadcrumb(context);
  try {
    target.recordError(error instanceof Error ? error : new Error(String(error)));
  } catch {
    // Reporting a failure must not become one.
  }
}

/**
 * The hidden test trigger (UC-4.4, #180 step 8).
 *
 * Two acceptance criteria need a crash that somebody caused on purpose, in a
 * *release* build: a native crash that arrives with real frames because the
 * dSYM and the R8 mapping were uploaded, and a JS error that arrives with
 * `src/` names because the exported Hermes source map was kept.
 *
 * Neither can be shown in a development build. Collection is off there on
 * purpose, and a development bundle is neither minified nor obfuscated — so a
 * crash from one proves nothing about symbols. The trigger is therefore
 * reachable in **staging**, which is a release build a closed tester installs,
 * and never in production: `releaseConfigProblems` refuses to *configure* a
 * production build with `EXPO_PUBLIC_ENABLE_TEST_CRASH` set at all, so no
 * binary that could reach this is ever made.
 *
 * `testCrashEnabled()` here is the belt, not the braces. The build guard is
 * what makes the guarantee; this makes a mistake in a screen harmless too.
 */
export function triggerTestCrash(kind: 'native' | 'javascript'): void {
  if (!testCrashEnabled()) return;
  if (kind === 'javascript') {
    // Thrown rather than recorded: what has to be proven is that an
    // *unhandled* JS error reaches Crashlytics through React Native Firebase's
    // global handler with Hermes frames, and that the stored map turns those
    // offsets back into file names. `recordError` would take a different path.
    throw new Error('MaybeSitter test crash (JavaScript)');
  }
  client()?.crash();
}

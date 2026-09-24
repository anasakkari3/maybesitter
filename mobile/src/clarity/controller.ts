import { CLARITY_PRIVACY_VERSION, CLARITY_PROJECT_ID } from './config';
import type { ClaritySdk } from './native';
import { SCREEN_FLOWS, STAGES, REPLAY_EVENTS, type ReplayEvent } from './policy';
import type { Screen } from '../state/types';

export interface ReplayContext {
  screen: Screen | typeof STAGES[number];
  flow: typeof SCREEN_FLOWS[Screen] | 'onboarding';
  locale: 'ar' | 'en' | 'he';
  theme: 'light' | 'dark';
  environment: 'development' | 'staging' | 'production';
  platform: 'ios' | 'android';
}

function validContext(c: ReplayContext): boolean {
  return (Object.hasOwn(SCREEN_FLOWS, c.screen) || (STAGES as readonly string[]).includes(c.screen))
    && (!Object.hasOwn(SCREEN_FLOWS, c.screen) || SCREEN_FLOWS[c.screen as Screen] !== 'excluded')
    && (Object.values(SCREEN_FLOWS).includes(c.flow as never) || c.flow === 'onboarding')
    && c.flow !== 'excluded'
    && ['ar', 'en', 'he'].includes(c.locale) && ['light', 'dark'].includes(c.theme)
    && ['development', 'staging', 'production'].includes(c.environment)
    && ['ios', 'android'].includes(c.platform);
}

/** Owns the SDK's process-wide lifetime; React may mount/unmount more than once. */
export function createReplayController(load: () => ClaritySdk | null) {
  let sdk: ClaritySdk | null = null;
  let initialized = false;
  let ready = false;
  let allowed = false;
  // The SDK may resume a persisted session at initialization. Rotate it before
  // tagging, including when consent changes while native startup waits.
  let needsFreshSession = true;
  let changingSession = false;
  let context: ReplayContext | null = null;
  let revision = 0;
  let queue = Promise.resolve();

  function stop() {
    if (allowed) needsFreshSession = true;
    allowed = false;
    revision += 1;
    // Do not wait behind pending initialization, session callbacks, or tag writes.
    if (sdk) {
      try { void sdk.pause().catch(() => undefined); } catch { /* Unavailable bridge. */ }
      try { void sdk.consent(false, false).catch(() => undefined); } catch { /* Unavailable bridge. */ }
    }
  }

  function sessionReady() {
    if (!allowed) { stop(); return; }
    if (!sdk || !ready || changingSession) return;
    if (!needsFreshSession) { synchronize(); return; }
    needsFreshSession = false;
    changingSession = true;
    ready = false;
    try {
      sdk.startNewSession(() => {
        changingSession = false;
        ready = true;
        sessionReady();
      });
      wakeRotation();
    } catch { changingSession = false; stop(); }
  }

  function wakeRotation() {
    // Android completes a requested rotation on its next captured frame, not
    // while paused. Wake it only with current consent; the root remains fully
    // masked and application metadata/events still wait for the callback.
    if (context?.platform !== 'android' || !changingSession) return;
    const expected = revision;
    queue = queue.then(async () => {
      const current = () => allowed && changingSession && expected === revision;
      if (!sdk || !current()) return;
      // Leave native storage consent unchanged until the rotation callback:
      // changing it here requests another SDK rotation and replaces that callback.
      await sdk.resume();
      if (!allowed) stop();
    }).catch(() => { stop(); });
  }

  function synchronize() {
    const expected = ++revision;
    queue = queue.then(async () => {
      const current = () => expected === revision && allowed && ready && context !== null;
      if (!sdk || !current()) return;
      const c = context!;
      // Advertising consent is never granted. Consent alone is not a capture gate.
      if (!await sdk.consent(false, true)) { stop(); return; }
      if (!current()) return;
      await sdk.setCurrentScreenName(c.screen);
      const tags = {
        flow: c.flow, locale: c.locale, theme: c.theme, environment: c.environment,
        platform: c.platform, privacy: CLARITY_PRIVACY_VERSION, client: 'react_native',
      };
      for (const [key, value] of Object.entries(tags)) {
        if (!current()) return;
        await sdk.setCustomTag(key, value);
      }
      if (current()) await sdk.resume();
      // A revoke can race a native resume already in flight. Stop again after it.
      if (!current() && !allowed) stop();
    }).catch(() => { stop(); });
  }

  return {
    update(next: ReplayContext | null, consent: boolean, enabled: boolean): void {
      context = next && validContext(next) ? next : null;
      if (!enabled || !consent || !context) { stop(); return; }
      sdk ??= load();
      if (!sdk) return;
      allowed = true;
      if (!initialized) {
        try {
          const registered = sdk.setOnSessionStartedCallback(() => {
            // Explicit rotation has its own completion callback. A global
            // notification for the old session cannot finish that rotation.
            if (changingSession) return;
            ready = true;
            sessionReady();
          });
          if (!registered) { stop(); return; }
          initialized = true;
          sdk.initialize(CLARITY_PROJECT_ID, { logLevel: sdk.LogLevel.None });
        } catch { stop(); }
      } else if (ready) sessionReady();
      else if (changingSession) wakeRotation();
    },
    stop,
    event(value: ReplayEvent): void {
      if (!allowed || !ready || !sdk || !(REPLAY_EVENTS as readonly string[]).includes(value)) return;
      try { void sdk.sendCustomEvent(value).catch(() => undefined); } catch { /* Optional telemetry. */ }
    },
    /** Used in privacy tests to let queued native calls settle. */
    settled: () => queue,
  };
}

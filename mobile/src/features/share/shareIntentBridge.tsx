/**
 * The one module that imports `expo-share-intent` at run time (UC-3.0, #183).
 *
 * Everything else in this feature — `intake.ts`'s normalisation, the provider's
 * state, the screen — depends only on types. That separation is what lets the
 * client-side limits be tested as arithmetic, with no native module and no
 * device, which matters because the criterion they serve is *"oversized or
 * disallowed input is rejected on device (no network call)"*.
 *
 * ── Nothing here is native-module-dependent at load ──────────────
 *
 * `expo-share-intent` resolves its native side with
 * `requireOptionalNativeModule`, so importing it in a build without the share
 * extension — Expo Go, a jest run, the web bundle — yields `null` and the hook
 * simply never fires. That is why this can be mounted unconditionally rather
 * than behind a flag: a build with the feature off still mounts a provider that
 * has nothing to report.
 *
 * ── `debug` is off unless a developer turns it on ────────────────
 *
 * The library's `debug` option `console.debug`s the parsed intent — the shared
 * text, the file paths — into the device log, where any other process can read
 * it. `shareIntentDebugEnabled()` needs a development bundle *and*
 * `APP_ENV=development` *and* the variable, and `releaseConfigProblems` refuses
 * to configure a staging or production build that sets it at all.
 */
import React, { useMemo } from 'react';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { shareIntentDebugEnabled } from '../../config/env';

/**
 * What the app needs from the library, narrowed.
 *
 * Narrower than `useShareIntentContext`'s own return on purpose: the provider
 * below never reads `isReady` or `error`, and a seam that exposed them would
 * invite a screen to render the library's error string — which can quote the
 * intent it failed to parse.
 */
export interface NativeShareIntent {
  hasShareIntent: boolean;
  shareIntent: ReturnType<typeof useShareIntentContext>['shareIntent'];
  /**
   * Clears the native module's record of the share.
   *
   * It does **not** delete the files. On iOS this nils one key in the App
   * Group's `UserDefaults` (`ExpoShareIntentModule.swift`'s `clearShareIntent`)
   * and leaves everything the extension copied into the container behind;
   * `src/lib/shareFiles.ts` is the half that deletes.
   */
  reset: () => void;
}

export function ShareIntentHost({ children }: { children: React.ReactNode }) {
  // Memoised: the library holds `options` in effect dependency lists, and a new
  // object every render would re-subscribe the native listener on every render.
  const options = useMemo(
    () => ({
      debug: shareIntentDebugEnabled(),
      // The default. Spelled out because it is load-bearing: backgrounding the
      // app drops the intent, so a share left on screen and abandoned does not
      // come back when the app is reopened days later.
      resetOnBackground: true,
    }),
    [],
  );
  return <ShareIntentProvider options={options}>{children}</ShareIntentProvider>;
}

export function useNativeShareIntent(): NativeShareIntent {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  return { hasShareIntent, shareIntent, reset: () => resetShareIntent(true) };
}

/**
 * The two native modules, resolved lazily and in one place (UC-3.11 #196, UC-3.0b #184).
 *
 * ── Why lazily ───────────────────────────────────────────────────
 *
 * `expo-notifications` and `@react-native-firebase/messaging` are native. A
 * build without them, or a test that never mounts them, must still start: a
 * missing reminder is a degradation, a white screen at launch is not. So every
 * caller asks for the module at the moment it needs it and copes with `null`.
 *
 * ── Why `require` and not `await import()` ───────────────────────
 *
 * A native dynamic `import()` is what Metro ships, but Jest rejects it without
 * `--experimental-vm-modules` — and it rejects it *at the call*, so the
 * rejection surfaces inside whatever effect happened to trigger the load
 * rather than as a missing module. That is not theoretical here: the first
 * version of this lane used `await import()` and took nine unrelated screen
 * suites down with `A dynamic import callback was invoked without
 * --experimental-vm-modules`, none of which mention notifications.
 * `src/i18n/__tests__/hermesPlurals.test.ts` records the same finding for the
 * same reason. `require` is also what `jest.mock` intercepts, so the inert
 * mocks in `jest.setup.js` are what a screen test actually gets.
 *
 * Metro resolves an inline `require` statically, so nothing here is a lazy
 * chunk on device; it is a deferred *evaluation*, which is all that was ever
 * wanted.
 */

type NotificationsModule = typeof import('expo-notifications');
type MessagingModule = typeof import('@react-native-firebase/messaging');

/**
 * `expo-notifications`, or null when this build does not have it.
 *
 * Not memoised: `require` already caches, and a memo here would freeze a
 * `jest.mock` from the first test file that touched it.
 */
export function notificationsModule(): NotificationsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-notifications') as NotificationsModule;
  } catch {
    return null;
  }
}

/** `@react-native-firebase/messaging`, or null when this build does not have it. */
export function messagingModule(): MessagingModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@react-native-firebase/messaging') as MessagingModule;
  } catch {
    return null;
  }
}

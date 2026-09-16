/**
 * The Android channels and the iOS categories, named once (UC-3.11, #196).
 *
 * ── A channel's importance is fixed the moment it is created ─────
 *
 * Android will not let an app raise or lower a channel after the first
 * `setNotificationChannelAsync`; only the user can, from system settings. So a
 * kind of notification that needs a different importance needs a *different
 * channel*, and renaming one of these — or reusing one for something louder —
 * would leave every existing install on the old importance for ever. That is
 * why UC-3.12a (#197) adds `maybesitter_must` rather than turning one of these
 * up, and why this list is additive.
 *
 * ── A push may only name a channel that is in here ───────────────
 *
 * Android *drops* a notification whose `channel_id` does not exist on the
 * device — it does not fall back to the default. `CHANNEL_FOR` in
 * `lib/push/pushService.ts` is checked against this file by
 * `tests/push/pushService.test.ts`, so a server push can never name a channel
 * the app has not created.
 */

/** Matches `AndroidImportance` without importing the native module at load. */
export const ANDROID_IMPORTANCE_DEFAULT = 3;

export interface AndroidChannelSpec {
  readonly id: string;
  /** Read from the locale bundle at setup time; this is the key, not the text. */
  readonly nameKey: 'notifChannelGeneral' | 'notifChannelAwareness';
  readonly importance: number;
}

/**
 * `maybesitter_general` is the plugin's `defaultChannel`, so it is also where
 * anything that arrives without a channel lands. `maybesitter_awareness` is the
 * gentle reminder: DEFAULT importance, which makes a sound and a banner but
 * never a heads-up interruption over what the person is doing.
 */
export const ANDROID_CHANNELS: readonly AndroidChannelSpec[] = [
  { id: 'maybesitter_general', nameKey: 'notifChannelGeneral', importance: ANDROID_IMPORTANCE_DEFAULT },
  { id: 'maybesitter_awareness', nameKey: 'notifChannelAwareness', importance: ANDROID_IMPORTANCE_DEFAULT },
];

export const GENERAL_CHANNEL_ID = 'maybesitter_general';
export const AWARENESS_CHANNEL_ID = 'maybesitter_awareness';

/**
 * The category a soft reminder is filed under.
 *
 * It carries no actions yet: UC-3.14 (#200) defines the buttons. Registering
 * it now means the notifications this issue schedules are already the ones
 * those buttons will attach to, rather than a second generation of them.
 */
export const AWARENESS_CATEGORY_ID = 'com.maybesitter.notification.category.awareness';
/** The morning plan's, for the pushes UC-3.10a (#194) will send. */
export const PLAN_CATEGORY_ID = 'com.maybesitter.notification.category.plan';

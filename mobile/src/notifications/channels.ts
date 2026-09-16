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
 * why UC-3.12a (#197) adds `maybesitter_hard` rather than turning one of these
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

/**
 * expo-notifications' own `AndroidImportance` numbering, without importing the
 * native module at load.
 *
 * These are **not** Android's `NotificationManager.IMPORTANCE_*` values, and
 * that difference was a live defect: this file used to pass `3` as "default",
 * which is Android's number for DEFAULT and expo's for **MIN** —
 * `NotificationImportance.fromEnumValue(3)` in
 * `expo-notifications/android/.../enums/NotificationImportance.java`. So the
 * gentle-reminder channel would have been created silent, with no status-bar
 * icon, on every install. `channels.test.ts` pins these against the enum the
 * library exports, so the two numberings cannot be confused again.
 */
export const ANDROID_IMPORTANCE_DEFAULT = 5;
export const ANDROID_IMPORTANCE_HIGH = 6;
/** expo's `AndroidAudioUsage.ALARM` and `AndroidAudioContentType.SONIFICATION`. */
export const ANDROID_AUDIO_USAGE_ALARM = 4;
export const ANDROID_AUDIO_CONTENT_SONIFICATION = 4;

export interface AndroidChannelSpec {
  readonly id: string;
  /** Read from the locale bundle at setup time; this is the key, not the text. */
  readonly nameKey: 'notifChannelGeneral' | 'notifChannelAwareness' | 'notifChannelHard';
  readonly importance: number;
  /** A bundled sound file, by name with its extension. Absent means the system default. */
  readonly sound?: string;
  /** Alarm audio, for the one channel whose whole purpose is to be heard. */
  readonly alarmAudio?: boolean;
  readonly vibrationPattern?: readonly number[];
  readonly enableLights?: boolean;
}

/**
 * The Must reminder's sound (UC-3.12a, #197), bundled by the expo-notifications
 * plugin's `sounds` list in `app.config.ts` — into the iOS app bundle and into
 * Android's `res/raw`. Named with its extension, which is what both platforms'
 * lookups take. The server's push names the same file (#198).
 */
export const HARD_SOUND = 'maybesitter_hard.wav';

/**
 * `maybesitter_general` is the plugin's `defaultChannel`, so it is also where
 * anything that arrives without a channel lands. `maybesitter_awareness` is the
 * gentle reminder: DEFAULT importance, which makes a sound and a banner but
 * never a heads-up interruption over what the person is doing.
 *
 * `maybesitter_hard` ("Must reminders", #197) is the one channel at HIGH
 * importance — a heads-up over whatever is on screen — with the bundled sound
 * played as **alarm** audio, so it is governed by the alarm volume rather than
 * the notification volume a person may have turned down. Only the strong stage
 * uses it. It is not a full-screen intent and it does not bypass Do Not
 * Disturb: `USE_FULL_SCREEN_INTENT` is blocked in `app.config.ts`, and a
 * heads-up with alarm audio is the ceiling #197 sets.
 */
export const ANDROID_CHANNELS: readonly AndroidChannelSpec[] = [
  { id: 'maybesitter_general', nameKey: 'notifChannelGeneral', importance: ANDROID_IMPORTANCE_DEFAULT },
  { id: 'maybesitter_awareness', nameKey: 'notifChannelAwareness', importance: ANDROID_IMPORTANCE_DEFAULT },
  {
    id: 'maybesitter_hard',
    nameKey: 'notifChannelHard',
    importance: ANDROID_IMPORTANCE_HIGH,
    sound: HARD_SOUND,
    alarmAudio: true,
    vibrationPattern: [0, 400, 250, 400],
    enableLights: true,
  },
];

export const GENERAL_CHANNEL_ID = 'maybesitter_general';
export const AWARENESS_CHANNEL_ID = 'maybesitter_awareness';
export const HARD_CHANNEL_ID = 'maybesitter_hard';

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
/**
 * The Must reminder's category (UC-3.12a, #197).
 *
 * The identifier is fixed by #197 and #198, and it is a contract rather than a
 * name: the server's push sends it as `aps.category` (#198), and UC-3.14 (#200)
 * attaches its buttons to it. Registered with no actions here, for the same
 * reason the awareness category is.
 */
export const HARD_CATEGORY_ID = 'com.maybesitter.notification.category.hard';

/**
 * Everything the notification system needs before it can be used (UC-3.11, #196).
 *
 * Run once, from `App.tsx`, and deliberately **not** from a screen: channels
 * and categories are process-wide facts, and creating them twice from two
 * mounts is how a channel ends up created with whichever importance the second
 * caller happened to pass.
 *
 * It asks for nothing. Creating a channel does not prompt, registering a
 * category does not prompt, and setting the foreground handler does not
 * prompt. The one prompt this app makes is in `permission.ts` and is reached
 * only when the user turns reminders on.
 */
import { Platform } from 'react-native';
import {
  ANDROID_AUDIO_CONTENT_SONIFICATION,
  ANDROID_AUDIO_USAGE_ALARM,
  ANDROID_CHANNELS,
  AWARENESS_CATEGORY_ID,
  HARD_CATEGORY_ID,
  PLAN_CATEGORY_ID,
} from './channels';
import { notificationsModule } from './nativeModules';

export interface ChannelNames {
  readonly notifChannelGeneral: string;
  readonly notifChannelAwareness: string;
  readonly notifChannelHard: string;
}

let configured = false;

/**
 * Installs the foreground handler and creates the channels and categories.
 *
 * Safe to call more than once — it is a no-op after the first — because the
 * app's root effect runs again in development on every fast refresh.
 */
export async function configureNotifications(names: ChannelNames): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    const Notifications = notificationsModule();
    if (!Notifications) throw new Error('expo-notifications is not in this build');

    /*
     * A reminder that arrives while the app is open is still a reminder.
     *
     * The default behaviour is to show nothing in the foreground, which for
     * this product means the user gets no heads-up for the thirty seconds they
     * happen to be looking at their week — the one case where they might
     * plausibly have been looking at the wrong screen. The banner shows; the
     * badge does not, for the reason `permission.ts` gives.
     */
    Notifications.setNotificationHandler({
      handleNotification: async notification => {
        // The server's backup for a Must reminder the phone is already showing
        // (UC-3.12b, #198). Asked only for that kind, so every other
        // notification pays nothing for the lookup.
        const show = !isBackupForShownRing(notification.request.content.data)
          || !isBackupAlreadyShown(
            notification.request.content.data,
            (await Notifications.getPresentedNotificationsAsync()).map(shown => shown.request.identifier),
          );
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show,
          shouldSetBadge: false,
        };
      },
    });

    /*
     * The category the soft reminder is filed under.
     *
     * No actions yet — UC-3.14 (#200) decides what the buttons do and what
     * they mean. Registering it now means the requests this issue schedules
     * are already the ones those buttons attach to.
     */
    await Notifications.setNotificationCategoryAsync(AWARENESS_CATEGORY_ID, []);
    await Notifications.setNotificationCategoryAsync(PLAN_CATEGORY_ID, []);
    // The Must reminder's (#197). #200 adds its buttons under this same id.
    await Notifications.setNotificationCategoryAsync(HARD_CATEGORY_ID, []);

    if (Platform.OS === 'android') {
      for (const channel of ANDROID_CHANNELS) {
        await Notifications.setNotificationChannelAsync(channel.id, {
          name: names[channel.nameKey],
          importance: channel.importance,
          ...(channel.sound ? { sound: channel.sound } : {}),
          ...(channel.alarmAudio
            ? {
              audioAttributes: {
                usage: ANDROID_AUDIO_USAGE_ALARM,
                contentType: ANDROID_AUDIO_CONTENT_SONIFICATION,
              },
            }
            : {}),
          ...(channel.vibrationPattern ? { vibrationPattern: [...channel.vibrationPattern] } : {}),
          ...(channel.enableLights ? { enableLights: true } : {}),
        });
      }
    }
  } catch {
    // No native module: a unit test, or a build without notifications. The app
    // must still start — a missing reminder is a degradation, a white screen
    // is not.
    configured = false;
  }
}

export function resetNotificationSetupForTests(): void {
  configured = false;
}

/** A push the server sent as the backup for a Must reminder (#198). */
export function isBackupForShownRing(data: unknown): boolean {
  return !!data && typeof data === 'object' && (data as Record<string, unknown>).kind === 'hard_reminder';
}

/**
 * Whether the local Must ring this backup stands in for is already on screen.
 *
 * In the background the two cannot both be shown: the push carries the local
 * ring's identifier as its collapse id (iOS) and tag (Android), and each
 * platform replaces a notification under the same identifier. In the
 * foreground this handler decides, so it drops the backup when the ring is
 * there — the one place a double could still reach the person.
 */
export function isBackupAlreadyShown(data: unknown, presentedIdentifiers: readonly string[]): boolean {
  if (!isBackupForShownRing(data)) return false;
  // The server sends the ring's own identifier (it is bounded, and may be a
  // hash of the commitment id — see `mustRingIdentifier`), so it is compared
  // as sent rather than rebuilt here.
  const notificationId = (data as Record<string, unknown>).notificationId;
  if (typeof notificationId !== 'string' || notificationId === '') return false;
  return presentedIdentifiers.includes(notificationId);
}

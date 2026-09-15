/**
 * Asking for the notification permission, once, at the right moment (UC-3.11, #196).
 *
 * ── iOS gives an app one chance ──────────────────────────────────
 *
 * The system prompt can be shown once per install. Spending it at cold start,
 * or during onboarding before there is a single commitment to be reminded
 * about, is spending it on the version of the question most likely to be
 * answered no — and there is no second version. So this is called from exactly
 * one place: the moment the user turns gentle reminders on.
 * `onboardingFlow.test.tsx` asserts at the source that nothing under
 * `src/features/onboarding` can reach it.
 *
 * ── Denied is not an error ───────────────────────────────────────
 *
 * It is an answer. The screen says what it means and offers
 * `Linking.openSettings()`, which is the only place the answer can be changed
 * afterwards — and is what `NotificationsSettingsScreen` has offered since
 * UC-2.R4 (#174).
 *
 * ── `provisional` is why the simulator is testable at all ────────
 *
 * iOS provisional authorisation delivers quietly to Notification Centre with
 * no prompt. It is a real granted-enough state: the device registry treats it
 * as pushable, and it is the only way to see a notification on a simulator,
 * which cannot grant the real permission.
 *
 * This app never *asks* for it. `requestPermissionsAsync` is called without
 * `allowProvisional`, so a device reports `provisional` only because something
 * outside the app put it there — a dev build, or a TestFlight install that
 * used it. Asking for it would be worse than it sounds: provisional
 * authorisation answers the one prompt iOS allows, quietly, so the user would
 * never be offered the real question and their reminders would arrive silently
 * in Notification Centre for ever. The consequence for verification is stated
 * plainly rather than worked around: a simulator cannot prove a soft reminder
 * is *seen*, only that it was scheduled.
 */

import { notificationsModule } from './nativeModules';

export type NotificationPermission = 'granted' | 'provisional' | 'denied' | 'undetermined';

/** Enough of expo-notifications' answer to decide, so tests need no SDK. */
export interface PermissionResponseLike {
  readonly granted?: boolean;
  readonly status?: string;
  readonly ios?: { readonly status?: number } | undefined;
}

/**
 * iOS's `UNAuthorizationStatus`. `3` is provisional; anything else granted is
 * a full grant. The numbers are the platform's, restated so the mapping below
 * can be read without opening the SDK.
 */
export const IOS_STATUS_PROVISIONAL = 3;

/**
 * One answer out of the three shapes the SDK can report it in.
 *
 * Exported and pure so the mapping is tested directly. Getting it wrong in the
 * generous direction would have the app tell the server `granted` for a device
 * that shows nothing, and the user would be told their reminders are on.
 */
export function permissionFrom(response: PermissionResponseLike | null | undefined): NotificationPermission {
  if (!response) return 'undetermined';
  if (response.ios?.status === IOS_STATUS_PROVISIONAL) return 'provisional';
  if (response.granted === true) return 'granted';
  if (response.status === 'granted') return 'granted';
  if (response.status === 'denied') return 'denied';
  return 'undetermined';
}

/** What the device currently says, without asking the user anything. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  try {
    const Notifications = notificationsModule();
    if (!Notifications) return 'undetermined';
    return permissionFrom(await Notifications.getPermissionsAsync());
  } catch {
    // No native module — a unit test, or a build without notifications. The
    // honest answer is "nobody has been asked", not "denied".
    return 'undetermined';
  }
}

/**
 * Asks, and answers with what the user said.
 *
 * `allowBadge` is false on purpose: MaybeSitter has no number to put on its
 * icon that would mean anything. A badge counting "things you have not done"
 * is the nagging this product is against, stated in the one place a user sees
 * it without opening the app.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  try {
    const Notifications = notificationsModule();
    if (!Notifications) return 'undetermined';
    const existing = permissionFrom(await Notifications.getPermissionsAsync());
    // Asking again after an answer is a no-op on iOS and a second prompt on
    // some Android versions; either way the answer is already known.
    if (existing !== 'undetermined') return existing;
    return permissionFrom(await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }));
  } catch {
    return 'undetermined';
  }
}

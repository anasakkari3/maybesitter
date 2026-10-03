/**
 * Asking for the notification permission, once, at the right moment (UC-3.11, #196).
 *
 * ── iOS gives an app one chance ──────────────────────────────────
 *
 * The system prompt can be shown once per install on iOS. So it is asked
 * where the person has just been told what it is for: onboarding's reminders
 * step, on «يلا نبلّش» (audit 2026-10-03, #7) — never on «بعدين» —, turning
 * something that rings on in Settings, Settings' own «اسمح», and right after
 * the first confirmed commitment that has a time (`firstMomentPrompt.ts`).
 * `onboardingFlow.test.tsx` asserts at the source that no other onboarding
 * step can reach it.
 *
 * ── `denied` means the phone will not ask again ──────────────────
 *
 * Android 13+ reports a POST_NOTIFICATIONS that has never been asked as
 * `denied` with `canAskAgain` (expo-notifications reads
 * `areNotificationsEnabled()`, false until the grant). Read raw, that sent
 * every new Android user to phone settings to undo an answer they never gave,
 * and no in-app path ever showed the prompt. So the app reads the
 * permission through `getNotificationPermissionState`: `canPrompt` says
 * whether asking would put the system prompt on screen, and
 * `getNotificationPermission` answers `undetermined` for an Android `denied`
 * that can still be asked. `denied` is left for the case where only the
 * phone's settings can change it — and there the screen offers
 * `Linking.openSettings()`, as `NotificationsSettingsScreen` has since
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

import { Platform } from 'react-native';
import { notificationsModule } from './nativeModules';

export type NotificationPermission = 'granted' | 'provisional' | 'denied' | 'undetermined';

/** Enough of expo-notifications' answer to decide, so tests need no SDK. */
export interface PermissionResponseLike {
  readonly granted?: boolean;
  readonly status?: string;
  /** Whether the OS will still show its prompt. */
  readonly canAskAgain?: boolean;
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

/**
 * Whether asking now would put the system prompt on screen.
 *
 * `undetermined` always would. A `denied` would only on **Android**, and only
 * while `canAskAgain` is true — and that is the case that matters (audit
 * 2026-10-03, #7). On Android 13+ expo-notifications reports a
 * POST_NOTIFICATIONS that has *never been asked* as `denied`, because its
 * status is denied whenever `areNotificationsEnabled()` is false, and that is
 * false until the permission is granted. Reading it as an answer meant the
 * prompt was never shown on any Android 13+ phone. Android itself decides when
 * to stop showing it (a second "Don't allow" sets `canAskAgain` false).
 *
 * iOS is untouched: a denial there is final, whatever the flag says, and
 * provisional is a granted-enough state that is never asked over (see the
 * header).
 */
export function canPromptFrom(
  response: PermissionResponseLike | null | undefined,
  platform: string = Platform.OS,
): boolean {
  const permission = permissionFrom(response);
  if (permission === 'undetermined') return true;
  if (permission !== 'denied') return false;
  return platform === 'android' && response?.canAskAgain === true;
}

export interface NotificationPermissionState {
  /** What the OS reports, as-is. */
  readonly permission: NotificationPermission;
  /** Whether asking now would show the system prompt. */
  readonly canPrompt: boolean;
}

/** What the device currently says, and whether it would still ask. Asks nothing. */
export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  try {
    const Notifications = notificationsModule();
    if (!Notifications) return { permission: 'undetermined', canPrompt: true };
    const response = await Notifications.getPermissionsAsync();
    return { permission: permissionFrom(response), canPrompt: canPromptFrom(response) };
  } catch {
    // No native module — a unit test, or a build without notifications. The
    // honest answer is "nobody has been asked", not "denied".
    return { permission: 'undetermined', canPrompt: true };
  }
}

/**
 * The permission as the app acts on it: `denied` only when the phone will not
 * ask again. An Android `denied` that can still be asked is `undetermined` —
 * which is what it is — so every caller (the Settings banner, the Settings
 * list, the first-moment prompt, the device row) treats it as "ask in the
 * app", not "go to phone settings". See the header.
 */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  const { permission, canPrompt } = await getNotificationPermissionState();
  return permission === 'denied' && canPrompt ? 'undetermined' : permission;
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
    const current = await Notifications.getPermissionsAsync();
    // Asking again after a final answer is a no-op on iOS and a nag on
    // Android; `canPromptFrom` says when the OS would still show its prompt.
    if (!canPromptFrom(current)) return permissionFrom(current);
    return permissionFrom(await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    }));
  } catch {
    return 'undetermined';
  }
}

/**
 * Telling the server which phone to push to (UC-3.0b, #184).
 *
 * ── It never prompts ─────────────────────────────────────────────
 *
 * This runs after sign-in and on every token refresh, which is exactly the
 * wrong moment to ask anybody for permission. It *reports* the permission the
 * device already has — including `undetermined`, which it reports as `denied`,
 * because a device nobody has asked yet will not show a push and the server
 * must not spend a send on it. The prompt belongs to UC-3.11 (#196) and fires
 * when the user turns reminders on; the next registration then reports the new
 * answer.
 *
 * ── Who owns the token ───────────────────────────────────────────
 *
 * React Native Firebase, not expo-notifications. Both libraries register an
 * Android `FirebaseMessagingService` for `com.google.firebase.MESSAGING_EVENT`
 * — but expo-notifications declares its intent filter at `android:priority="-1"`
 * and RNFB's at the default, so the merged manifest resolves to RNFB and the
 * split is a property of the two libraries rather than of load order. (Read
 * out of the two `AndroidManifest.xml` files in `node_modules`, not assumed.)
 * expo-notifications keeps local notifications, channels, categories and tap
 * responses; RNFB keeps tokens and message receipt.
 *
 * ── Everything is injected ───────────────────────────────────────
 *
 * The token, the permission, the installation id and the two endpoints all
 * arrive as dependencies. Not for purity's sake: it is the only way to test
 * "mock mode registers nothing" and "a missing installation id registers
 * nothing" without a device, and those are the two paths that would otherwise
 * be discovered in production.
 */
import { Platform } from 'react-native';
import { apiLocale } from '../i18n/locale';
import { deviceTimeZone } from '../i18n/timezone';
import { apiMode, appVersion } from '../config/env';
import { installationId } from '../lib/installationId';
import { forgetDevice, registerDevice, type DeviceRegistration } from '../api/endpoints/devices';
import { messagingModule } from './nativeModules';
import { getNotificationPermission, type NotificationPermission } from './permission';

export interface PushRegistrationDeps {
  /** The FCM registration token, or null when there is none. */
  fcmToken(): Promise<string | null>;
  permission(): Promise<NotificationPermission>;
  installationId(): Promise<string | null>;
  register(registration: DeviceRegistration): Promise<unknown>;
  forget(installationId: string): Promise<unknown>;
  /** Deleting the token forces a fresh one on the next sign-in. */
  deleteToken(): Promise<void>;
  mode(): 'api' | 'mock';
  platform(): 'ios' | 'android';
  locale(): 'ar' | 'he' | 'en';
  timezone(): string;
  version(): string;
}

export type RegistrationOutcome =
  | 'registered'
  | 'skipped_mock_mode'
  | 'skipped_no_installation_id'
  | 'skipped_no_token'
  | 'failed';

/**
 * A permission nobody has been asked for is reported as `denied`.
 *
 * The server pushes to `granted` and `provisional` and skips `denied`. There is
 * no fourth state on the wire on purpose: a device in `undetermined` shows
 * nothing, so recording it as anything other than "do not push here" would
 * spend a send and a dedupe key on a notification no one can see.
 */
export function reportablePermission(permission: NotificationPermission): DeviceRegistration['pushPermission'] {
  return permission === 'undetermined' ? 'denied' : permission;
}

export async function registerDeviceForPush(
  deps: PushRegistrationDeps,
): Promise<RegistrationOutcome> {
  // Mock mode has no server to tell. Checked first so a developer running
  // against fixtures never writes a real device row.
  if (deps.mode() === 'mock') return 'skipped_mock_mode';

  const id = await deps.installationId();
  // No keychain, no stable id. Registering under a fresh uuid every launch
  // would leave one row per launch and push once per row.
  if (!id) return 'skipped_no_installation_id';

  const token = await deps.fcmToken();
  if (!token) return 'skipped_no_token';

  try {
    await deps.register({
      installationId: id,
      fcmToken: token,
      platform: deps.platform(),
      appVersion: deps.version(),
      locale: deps.locale(),
      timezone: deps.timezone(),
      pushPermission: reportablePermission(await deps.permission()),
    });
    return 'registered';
  } catch {
    // A failed registration is a phone that will not be pushed to until the
    // next launch or token refresh, which is a degradation. It is not a reason
    // to fail a sign-in, and it is never shown to the user.
    return 'failed';
  }
}

/**
 * Forgets this device, in the order that actually works.
 *
 * The `DELETE` goes first, while the session is still valid — after sign-out
 * there is no token to authorise it with. Then the FCM token is deleted, so
 * the next sign-in gets a fresh one rather than reusing one this account's row
 * used to point at.
 *
 * ── The token is deleted on every reason; the row is not ─────────
 *
 * `credentialIsGood` is false for `session_expired`, `revoked` and `deleted`,
 * where the `DELETE` could only ever answer 401 or 403 — a revoked account in
 * particular is refused by `requireMobileUser`, so that user cannot delete
 * their own device row at all.
 *
 * `deleteToken()` runs regardless, and that is the half that closes the leak.
 * The installation id deliberately outlives a sign-out and the FCM token
 * belongs to the *installation*, not to the account, so a session that ended
 * without killing the token leaves `users/alice/devices/{id}` pointing at a
 * token that is still live on that handset. Bob signs in on the same phone and
 * every push addressed to Alice arrives on his screen carrying her
 * `commitmentId`. Deleting the token needs no credential, works on every
 * reason, and makes the stale row reap itself the next time anything pushes to
 * it (`registration-token-not-registered`).
 *
 * The server-side version of this fix — evict a token from every other uid
 * when somebody registers it — is deliberately **not** done.
 * `parseDeviceRegistration` can validate a token's shape and can never
 * validate that the caller owns it, so that eviction would hand any
 * authenticated caller a way to switch off somebody else's notifications by
 * posting their token.
 */
export async function deregisterDeviceForPush(
  deps: PushRegistrationDeps,
  credentialIsGood: boolean,
): Promise<void> {
  if (deps.mode() === 'mock') return;
  if (credentialIsGood) {
    const id = await deps.installationId();
    if (id) {
      try {
        await deps.forget(id);
      } catch {
        // The row is left behind. The account-deletion cascade and FCM's own
        // `registration-token-not-registered` are what eventually clear it.
      }
    }
  }
  try {
    await deps.deleteToken();
  } catch {
    // Nothing to do: the caller is signing out either way.
  }
}

/**
 * The real dependencies.
 *
 * Every native module is resolved at use, for the reason `gateway.ts` gives:
 * this module is reachable from a component tree that unit tests render, and a
 * static `@react-native-firebase/messaging` import would fail those tests at
 * load rather than at use. `nativeModules.ts` says why that is a `require`.
 */
export function createPushRegistrationDeps(): PushRegistrationDeps {
  return {
    async fcmToken() {
      try {
        // The modular API: React Native Firebase v26 removed the namespaced
        // `messaging().getToken()` form.
        const messaging = messagingModule();
        if (!messaging) return null;
        return await messaging.getToken(messaging.getMessaging());
      } catch {
        return null;
      }
    },
    permission: getNotificationPermission,
    installationId,
    register: registerDevice,
    forget: forgetDevice,
    async deleteToken() {
      try {
        const messaging = messagingModule();
        if (!messaging) return;
        await messaging.deleteToken(messaging.getMessaging());
      } catch {
        // No native module, or no token to delete.
      }
    },
    mode: apiMode,
    platform: () => (Platform.OS === 'android' ? 'android' : 'ios'),
    locale: apiLocale,
    timezone: deviceTimeZone,
    version: appVersion,
  };
}

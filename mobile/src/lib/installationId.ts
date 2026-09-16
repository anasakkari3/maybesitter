/**
 * This installation's own id (UC-3.0b #184, reused by UC-3.1 #185).
 *
 * ── Why the device registry is keyed by this and not by the token ──
 *
 * Firebase rotates an FCM token without anybody asking. Keyed by the token,
 * every rotation would leave a dead `users/{uid}/devices/{…}` document behind
 * and the server would keep pushing into it until FCM refused. Keyed by the
 * installation, a rotation is an update to one row.
 *
 * ── Why SecureStore rather than AsyncStorage ─────────────────────
 *
 * Not because this is a credential — it is not; it authorises nothing and
 * identifies no person. It is because of what `AsyncStorage` does *not* do:
 * on iOS it is cleared when the app is deleted, but it is also plainly
 * readable by anything with the container, and on Android it is backed up by
 * default. An id that outlives a reinstall and is readable by another process
 * is a cross-install identifier, which is the thing an installation id must
 * not become. The keychain entry is app-scoped, and `WHEN_UNLOCKED_THIS_
 * DEVICE_ONLY` below keeps it off iCloud Keychain, so it never travels to the
 * user's other devices — two phones must be two rows.
 *
 * `eslint.config.js` forbids `expo-secure-store` under `src/api`,
 * `src/features` and `src/screens`. This file is outside all three on purpose:
 * it is the sanctioned use, and the import lives here so there is exactly one.
 *
 * ── A device that cannot store one does not get one ──────────────
 *
 * `installationId()` answers `null` when the keychain refuses, and push
 * registration is skipped. The alternative — mint a fresh uuid per launch —
 * would write a new device document on every cold start and push the same
 * notification once per launch the user ever made.
 */
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

export const INSTALLATION_ID_KEY = 'installation_id';

/** Matches `lib/push/deviceRegistry`'s server-side check exactly. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Off iCloud Keychain, and readable only while the device is unlocked.
 *
 * Two phones signed into one account must be two device documents; a synced
 * keychain item would make them one, and the second phone would silently stop
 * receiving anything the first collapsed.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

let cached: string | null = null;
let inFlight: Promise<string | null> | null = null;

/**
 * The id, minted on first call and kept afterwards.
 *
 * ── Why the in-flight promise, and not just the value ────────────
 *
 * Caching the resolved value is not enough, and the first version of this file
 * got it wrong in exactly the way its own comment said it must not. Push
 * registration and UC-3.1 (#185) both ask on a cold start; both reach
 * `getItemAsync` before either has written, both find nothing, both mint a
 * uuid — and the second `setItemAsync` wins, *after* the first has already
 * registered a device row under the id it was handed. One phone, two rows, two
 * copies of every push. So the whole read-or-mint is shared, not its answer.
 *
 * The same reasoning as the shared token refresh in `src/api/auth.ts`, and it
 * is a test that caught it here too.
 */
export async function installationId(): Promise<string | null> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = readOrMint().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function readOrMint(): Promise<string | null> {
  try {
    const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY, OPTIONS);
    if (stored && UUID.test(stored)) {
      cached = stored;
      return cached;
    }
    const minted = Crypto.randomUUID();
    await SecureStore.setItemAsync(INSTALLATION_ID_KEY, minted, OPTIONS);
    cached = minted;
    return cached;
  } catch {
    // No keychain, or a device that refuses to write to it. Registration is
    // skipped rather than done under an id that will not survive the launch.
    return null;
  }
}

/**
 * Forgets the id, on this device, for good.
 *
 * Deliberately **not** called on sign-out: the installation is a fact about
 * this copy of the app, not about the person, and re-minting one per sign-in
 * would make one phone look like many. Sign-out deletes the *device document*
 * under that account instead (`DELETE /api/mobile/devices/{installationId}`),
 * which is the row that carries the token.
 */
export async function forgetInstallationId(): Promise<void> {
  cached = null;
  inFlight = null;
  try {
    await SecureStore.deleteItemAsync(INSTALLATION_ID_KEY, OPTIONS);
  } catch {
    // Nothing to do; the caller is tearing down.
  }
}

/** Tests only: drop the in-process cache between cases. */
export function resetInstallationIdForTests(): void {
  cached = null;
  inFlight = null;
}

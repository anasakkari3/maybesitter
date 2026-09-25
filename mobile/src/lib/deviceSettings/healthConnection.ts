import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Whether this installation reads Apple Health for this account, and when it
 * last tried (Health → energy).
 *
 * ── Why it is on the device ──────────────────────────────────────
 *
 * The HealthKit permission is a fact about this phone: another phone signed in
 * to the same account has its own Health store and its own grant, and iOS
 * never tells an app whether a read type was denied. So "the user turned this
 * on here" can only be remembered here. It is what the foreground refresh
 * checks before it reads anything.
 *
 * ── What is in it ────────────────────────────────────────────────
 *
 * A boolean and one instant, keyed by account. No sample, no score, no band:
 * the readiness summary itself goes to the server and is read back from there,
 * and raw Health data never leaves the native module. Disconnect removes the
 * key (with the native `clearLocalConnection`); iOS keeps the permission until
 * the user changes it in Health, which the screen says.
 */
export const HEALTH_CONNECTION_KEY_PREFIX = 'health.connection.v1.';

export interface HealthConnection {
  connected: true;
  /** When the last read was attempted, successful or not. */
  lastAttemptAt: string | null;
}

function keyFor(uid: string): string {
  return `${HEALTH_CONNECTION_KEY_PREFIX}${uid}`;
}

export function parseHealthConnection(raw: string | null): HealthConnection | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { connected?: unknown; lastAttemptAt?: unknown };
    if (value.connected !== true) return null;
    const at = typeof value.lastAttemptAt === 'string' && !Number.isNaN(Date.parse(value.lastAttemptAt))
      ? value.lastAttemptAt
      : null;
    return { connected: true, lastAttemptAt: at };
  } catch {
    return null;
  }
}

export async function loadHealthConnection(uid: string): Promise<HealthConnection | null> {
  try {
    return parseHealthConnection(await AsyncStorage.getItem(keyFor(uid)));
  } catch {
    // Unreadable is the same as never connected: the card offers the button.
    return null;
  }
}

export async function saveHealthConnection(uid: string, connection: HealthConnection): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(uid), JSON.stringify(connection));
  } catch {
    // It still applies for this session; the next launch asks again.
  }
}

export async function clearHealthConnection(uid: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(keyFor(uid));
  } catch {
    // Nothing to do: the next read of it answers "not connected" anyway.
  }
}

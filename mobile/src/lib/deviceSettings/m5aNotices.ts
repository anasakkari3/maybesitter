import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Whether this account said «خلّيها زي ما هي» to the one-time monitoring
 * upgrade notice on this phone (M5a R4.1, M5A-R35-004): one instant per
 * account, never anything the person wrote. Losing it shows the notice once
 * more, which is a question asked twice, not a change made — so it is best
 * effort.
 */
function upgradeDismissedKey(uid: string): string {
  return `m5a.monitorUpgradeDismissed.v1:${uid}`;
}

export async function loadMonitorUpgradeDismissed(uid: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(upgradeDismissedKey(uid))) !== null;
  } catch {
    return false;
  }
}

export async function saveMonitorUpgradeDismissed(uid: string, at: Date): Promise<void> {
  try {
    await AsyncStorage.setItem(upgradeDismissedKey(uid), at.toISOString());
  } catch {
    // Asked once more next time.
  }
}

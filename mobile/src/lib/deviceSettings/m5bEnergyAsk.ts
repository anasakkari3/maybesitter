import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * «مش اليوم» on Today's energy question (PLAN-M5b-1 R4.3, M5B-018): the
 * device-local date it was hidden on, per account. The row is hidden only
 * while the stored date is today's. Fail-open: an optional question shown
 * again costs nothing, so any storage error shows the row.
 */
function hiddenKey(uid: string): string {
  return `m5b.todayEnergyAskHidden.v1:${uid}`;
}

/** The device-local date, YYYY-MM-DD. */
export function localDay(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function loadEnergyAskHiddenToday(uid: string, now: Date = new Date()): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(hiddenKey(uid))) === localDay(now);
  } catch {
    return false;
  }
}

/** False when the date could not be stored: the caller shows the row again (fail-open). */
export async function saveEnergyAskHiddenToday(uid: string, now: Date = new Date()): Promise<boolean> {
  try {
    await AsyncStorage.setItem(hiddenKey(uid), localDay(now));
    return true;
  } catch {
    return false;
  }
}

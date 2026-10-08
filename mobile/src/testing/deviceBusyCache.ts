/**
 * Seeds the phone calendar's busy cache for one account, as a sync would
 * have left it (M4a: the cache is an owned envelope, `calendarBusy.ts`).
 *
 * Tests used to write a bare array to the unowned key; that key is now
 * deleted on sight, so a test that wants chips seeds them here, under the
 * account it signs in as.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BUSY_BLOCKS_KEY, type BusyCoverage } from '../lib/deviceSettings/calendarBusy';

export async function seedDeviceBusyCache(
  owner: string,
  blocks: readonly unknown[],
  options: { coverage?: BusyCoverage | null; syncedAt?: number | null } = {},
): Promise<void> {
  await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify({
    owner,
    blocks,
    coverage: options.coverage ?? null,
    syncedAt: options.syncedAt ?? null,
  }));
}

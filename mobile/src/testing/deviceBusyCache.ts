/**
 * Seeds the phone calendar's busy cache for one account, as a sync would
 * have left it (M4a: the cache is an owned envelope, `calendarBusy.ts`).
 *
 * Tests used to write a bare array to the unowned key; that key is now
 * deleted on sight, so a test that wants chips seeds them here, under the
 * account it signs in as.
 */
import { jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BUSY_BLOCKS_KEY, type BusyCoverage } from '../lib/deviceSettings/calendarBusy';
import { deviceCalendar } from '../features/calendar/deviceCalendar';
import * as trustEndpoints from '../api/endpoints/trust';

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

/**
 * The calendar switch on, and a phone that will not be read: what a test
 * wants when its chips must come from the seeded cache and nowhere else.
 *
 * The switch cannot simply be off any more: consent withdrawn takes the
 * phone's copy with it (owner decision 2026-10-09, M4A-R6-REV-001). A refused
 * read keeps the cached blocks for the chips and uploads nothing.
 */
export function calendarOnButUnreadable(participantId: string): void {
  jest.spyOn(trustEndpoints, 'getTrust').mockResolvedValue({
    success: true, participantId, trust: { analyticsConsent: false, calendarConsent: true },
  } as never);
  jest.spyOn(deviceCalendar, 'fetchBusyBlocks').mockRejectedValue(new Error('the calendar cannot be read'));
}

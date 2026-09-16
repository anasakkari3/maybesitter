/**
 * The busy blocks this device last read, kept on the device (UC-3.2, #186 step 3).
 *
 * ── Why there is a cache at all ──────────────────────────────────
 *
 * The conflict chip has to render at the moment a proposal appears, which is
 * often the moment somebody is on a train with no signal. Asking the server
 * would make the chip a network round trip; asking the calendar would make it a
 * permission prompt and a native read on the render path. So the last answer is
 * kept here and the sync refreshes it.
 *
 * ── Nothing here has ever held a title ───────────────────────────
 *
 * `src/api/`'s rule is that the query layer persists nothing, because an
 * unencrypted copy of somebody's life on disk is not worth a warm start. This
 * file is a deliberate exception and it is a narrow one: four fields per row,
 * no commitment text, and nothing that names what any of the time is *for*.
 *
 * It is re-projected on the way *out* as well as on the way in. That is not
 * belt and braces: AsyncStorage is a file other code on a rooted device can
 * write, a future version of this app could have written a wider row, and the
 * only way "a busy block has four keys" stays true for a value that has been
 * off the heap and back is to rebuild it from the keys we want rather than
 * trusting the keys we find.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DeviceBusyBlock } from '../../features/calendar/busyBlocks';

export const BUSY_BLOCKS_KEY = 'calendar.busy.v1';
export const BUSY_SYNCED_AT_KEY = 'calendar.busySyncedAt.v1';

/** A hard stop on what one device will keep, matching the upload limit. */
const MAX_CACHED_BLOCKS = 1000;

function blockFrom(raw: unknown): DeviceBusyBlock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.nativeId !== 'string' || row.nativeId === '') return null;
  if (typeof row.startAt !== 'string' || typeof row.endAt !== 'string') return null;
  if (!Number.isFinite(Date.parse(row.startAt)) || !Number.isFinite(Date.parse(row.endAt))) return null;
  return {
    nativeId: row.nativeId,
    startAt: row.startAt,
    endAt: row.endAt,
    allDay: row.allDay === true,
  };
}

export async function loadCachedBusyBlocks(): Promise<DeviceBusyBlock[]> {
  try {
    const raw = await AsyncStorage.getItem(BUSY_BLOCKS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(blockFrom)
      .filter((block): block is DeviceBusyBlock => block !== null)
      .slice(0, MAX_CACHED_BLOCKS);
  } catch {
    // An unreadable cache is no chips until the next sync, which is a screen
    // that says less rather than a screen that is wrong.
    return [];
  }
}

export async function saveCachedBusyBlocks(blocks: readonly DeviceBusyBlock[]): Promise<void> {
  try {
    const rows = blocks.slice(0, MAX_CACHED_BLOCKS).map((block) => ({
      nativeId: block.nativeId,
      startAt: block.startAt,
      endAt: block.endAt,
      allDay: block.allDay,
    }));
    await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify(rows));
  } catch {
    // The chips still work for this session from the value in memory.
  }
}

/** Disconnect, and sign-out. The blocks go before the server is even asked. */
export async function clearCachedBusyBlocks(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, BUSY_SYNCED_AT_KEY]);
  } catch {
    // Nothing useful to do. The next successful disconnect clears it.
  }
}

/** When this device last uploaded a window, or null. */
export async function loadBusySyncedAt(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(BUSY_SYNCED_AT_KEY);
    if (raw === null) return null;
    const ms = Number.parseInt(raw, 10);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    // Unknown reads as "never", which syncs once more than it had to.
    return null;
  }
}

export async function saveBusySyncedAt(at: Date): Promise<void> {
  try {
    await AsyncStorage.setItem(BUSY_SYNCED_AT_KEY, String(at.getTime()));
  } catch {
    // See above: the cost is an extra sync, not a wrong one.
  }
}

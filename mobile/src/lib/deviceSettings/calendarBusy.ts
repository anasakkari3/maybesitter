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
 *
 * ── One account's, never the installation's (M4a, M4A-R8-001) ────
 *
 * The cache used to be one key for the whole installation, read under any uid:
 * account B, signed in on A's phone, saw A's busy times until B's own first
 * read — and, when that read was denied or offline, for good. It is now one
 * envelope that names its owner: the blocks, the window they honestly cover,
 * and when they were last sent. A read under any other uid is empty, every uid
 * change clears it (`ApiProvider`), and the old unowned keys are deleted the
 * first time they are seen.
 *
 * ── Coverage, not only blocks ────────────────────────────────────
 *
 * "No busy block on Thursday" means Thursday is free only if Thursday was
 * read. So the envelope keeps the window the read covered, cut where the
 * upload had to cut it (`fitToLimit`), and a read that was refused keeps the
 * old blocks for the chips but covers nothing.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DeviceBusyBlock } from '../../features/calendar/busyBlocks';

/** The owned envelope. */
export const BUSY_BLOCKS_KEY = 'calendar.busy.v2';
/** The unowned keys before M4a: deleted on sight. */
export const LEGACY_BUSY_KEYS = ['calendar.busy.v1', 'calendar.busySyncedAt.v1'] as const;

/** A hard stop on what one device will keep, matching the upload limit. */
const MAX_CACHED_BLOCKS = 1000;

/** What the device read honestly covers: busy as shown from `startAt` up to `endAt`. */
export interface BusyCoverage {
  readonly startAt: string;
  readonly endAt: string;
}

export interface DeviceBusyCache {
  readonly blocks: DeviceBusyBlock[];
  /** Null when nothing was read, or the last read was refused. */
  readonly coverage: BusyCoverage | null;
  /** Epoch millis of the last successful upload, or null. */
  readonly syncedAt: number | null;
}

const EMPTY: DeviceBusyCache = { blocks: [], coverage: null, syncedAt: null };

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

function coverageFrom(raw: unknown): BusyCoverage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.startAt !== 'string' || typeof row.endAt !== 'string') return null;
  const start = Date.parse(row.startAt);
  const end = Date.parse(row.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { startAt: row.startAt, endAt: row.endAt };
}

function project(blocks: readonly DeviceBusyBlock[]): DeviceBusyBlock[] {
  return blocks.slice(0, MAX_CACHED_BLOCKS).map((block) => ({
    nativeId: block.nativeId,
    startAt: block.startAt,
    endAt: block.endAt,
    allDay: block.allDay,
  }));
}

async function dropLegacy(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([...LEGACY_BUSY_KEYS]);
  } catch {
    // Tried again on the next read.
  }
}

/** The envelope as stored, whoever owns it, or null. */
async function readEnvelope(): Promise<{ owner: string; cache: DeviceBusyCache } | null> {
  const raw = await AsyncStorage.getItem(BUSY_BLOCKS_KEY);
  if (raw === null) return null;
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.owner !== 'string' || row.owner === '') return null;
  const blocks = Array.isArray(row.blocks)
    ? row.blocks.map(blockFrom).filter((block): block is DeviceBusyBlock => block !== null).slice(0, MAX_CACHED_BLOCKS)
    : [];
  const syncedAt = typeof row.syncedAt === 'number' && Number.isFinite(row.syncedAt) ? row.syncedAt : null;
  return { owner: row.owner, cache: { blocks, coverage: coverageFrom(row.coverage), syncedAt } };
}

async function writeEnvelope(owner: string, cache: DeviceBusyCache): Promise<void> {
  await AsyncStorage.setItem(BUSY_BLOCKS_KEY, JSON.stringify({
    owner,
    blocks: project(cache.blocks),
    coverage: cache.coverage,
    syncedAt: cache.syncedAt,
  }));
}

/** `owner`'s cache: empty when another account wrote it, or it is unreadable. */
export async function loadDeviceBusy(owner: string): Promise<DeviceBusyCache> {
  await dropLegacy();
  try {
    const stored = await readEnvelope();
    return stored && stored.owner === owner ? stored.cache : EMPTY;
  } catch {
    // An unreadable cache is no chips until the next sync, which is a screen
    // that says less rather than a screen that is wrong.
    return EMPTY;
  }
}

/** `owner`'s cached blocks. */
export async function loadCachedBusyBlocks(owner: string): Promise<DeviceBusyBlock[]> {
  return (await loadDeviceBusy(owner)).blocks;
}

/**
 * A fresh read: the blocks and what they cover. `coverage` null keeps the old
 * blocks' place for the chips but claims nothing about free time.
 */
export async function saveCachedBusyBlocks(
  owner: string,
  blocks: readonly DeviceBusyBlock[],
  coverage: BusyCoverage | null,
): Promise<void> {
  try {
    const previous = await loadDeviceBusy(owner);
    await writeEnvelope(owner, { blocks: [...blocks], coverage, syncedAt: previous.syncedAt });
  } catch {
    // The chips still work for this session from the value in memory.
  }
}

/** A refused read: the blocks stay for the chips, and cover nothing any more. */
export async function uncoverCachedBusyBlocks(owner: string): Promise<void> {
  try {
    const previous = await loadDeviceBusy(owner);
    await writeEnvelope(owner, { ...previous, coverage: null });
  } catch {
    // The next read writes the envelope again.
  }
}

/** Disconnect, sign-out and every account change. The blocks go before the server is even asked. */
export async function clearCachedBusyBlocks(): Promise<void> {
  try {
    await AsyncStorage.multiRemove([BUSY_BLOCKS_KEY, ...LEGACY_BUSY_KEYS]);
  } catch {
    // Nothing useful to do. The next read under another owner is empty anyway.
  }
}

/** When this device last uploaded `owner`'s window, or null. */
export async function loadBusySyncedAt(owner: string): Promise<number | null> {
  return (await loadDeviceBusy(owner)).syncedAt;
}

export async function saveBusySyncedAt(owner: string, at: Date): Promise<void> {
  try {
    const previous = await loadDeviceBusy(owner);
    await writeEnvelope(owner, { ...previous, syncedAt: at.getTime() });
  } catch {
    // The cost is an extra sync, not a wrong one.
  }
}

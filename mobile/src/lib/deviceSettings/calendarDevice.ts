/**
 * What this installation knows about its own calendar writing (UC-3.1, #185).
 *
 * Four values, all of them device facts rather than account facts, which is
 * why they are here and not on the server:
 *
 *   `writerId`        who this installation is, so the account can tell two
 *                     phones apart
 *   `calendarId`      which calendar on *this* device the user picked
 *   `writtenEventIds` the events this installation put there
 *   `excludedCalendarIds` the calendars on this phone the user switched off
 *                     for busy time (first iPhone run, L7). Calendar ids
 *                     only — never a title, an account name or an event — and
 *                     meaningless on any other phone, which is why they are
 *                     not on the account.
 *
 * ── `writerId`, and the `installationId` this is not ─────────────
 *
 * #185's sketch names this `installationId` and points at
 * `src/lib/installationId.ts` from UC-3.0b (#184), which is being built in
 * another lane as this lands. Importing a file that does not exist yet would
 * mean this lane could not type-check, and writing that file here would mean
 * two lanes creating it. So duplicate suppression does not depend on #184 at
 * all: it needs a value that is *stable on this device and different from every
 * other device*, and a random uuid kept in AsyncStorage is exactly that.
 *
 * What it is not is durable across a reinstall. iOS Keychain — where #184's
 * value will live — survives deleting the app; AsyncStorage does not. The cost
 * is one-directional and small: a reinstalled app mints a new writer id, so it
 * sees the account's existing links as somebody else's and leaves them alone.
 * It writes no duplicate and it deletes nothing of anyone's. The user's remedy
 * is "Remove events MaybeSitter added" on the device that still owns them, or
 * the same button here once the links are re-established.
 *
 * When #184 lands, `resolveWriterId` is the one function that changes: it reads
 * the installation id instead of minting its own, and every stored link keeps
 * working because the server only ever compares the value for equality.
 *
 * ── `writtenEventIds` is for UC-3.2 (#186) ───────────────────────
 *
 * #186 reads busy time to warn about conflicts. Without this set it would count
 * MaybeSitter's own events as busy and tell the user their 15:00 commitment
 * collides with their 15:00 commitment. It is kept as a set of ids and nothing
 * else — no titles, no times.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

export const WRITER_ID_KEY = 'calendar.writerId.v1';
export const CALENDAR_ID_KEY = 'calendar.calendarId.v1';
export const WRITTEN_EVENT_IDS_KEY = 'calendar.writtenEventIds.v1';
export const EXCLUDED_CALENDAR_IDS_KEY = 'calendar.excludedCalendarIds.v1';

/** How many event ids are kept. Beyond this the oldest are dropped. */
const MAX_WRITTEN_EVENT_IDS = 2000;

let cachedWriterId: string | null = null;

/**
 * This installation's id, minted on first use.
 *
 * Cached in memory so the reconcile pass does not read storage once per
 * commitment. A failed read mints a fresh value rather than throwing: the
 * consequence of a new id is that this device claims nothing it does not
 * already own, which is the safe direction, and an exception here would take
 * the whole sync down.
 */
export async function resolveWriterId(): Promise<string> {
  if (cachedWriterId !== null) return cachedWriterId;
  let stored: string | null = null;
  try {
    stored = await AsyncStorage.getItem(WRITER_ID_KEY);
  } catch {
    stored = null;
  }
  if (typeof stored === 'string' && stored.trim() !== '') {
    cachedWriterId = stored;
    return stored;
  }
  const minted = Crypto.randomUUID();
  try {
    await AsyncStorage.setItem(WRITER_ID_KEY, minted);
  } catch {
    // Unwritable storage means a new id next launch. Still safe: it owns
    // nothing, so it overwrites nothing.
  }
  cachedWriterId = minted;
  return minted;
}

/** Forgets the cached id. For tests, and for a sign-out that clears storage. */
export function resetWriterIdCache(): void {
  cachedWriterId = null;
}

/**
 * ── Per account since M5a (M5A-R21-001, M5A-R20-004) ─────────────
 *
 * The calendar written into and the ids written are kept per account: on a
 * shared phone, account B must neither write into A's chosen calendar nor
 * skip A's events as its own. The installation-wide values are left where
 * they are and never migrated: each account chooses again (or the
 * sole-writable-calendar flow applies), and an id becomes this account's only
 * when one of its own commitments carries the matching device-calendar link
 * (`useDeviceCalendarSync` re-records those). Every other id reads as someone
 * else's event, which is busy — a redundant hint, never a missed clash.
 */
export function chosenCalendarKey(uid: string): string {
  return `${CALENDAR_ID_KEY}:${uid}`;
}

export function writtenEventIdsKey(uid: string): string {
  return `${WRITTEN_EVENT_IDS_KEY}:${uid}`;
}

/** The calendar this account picked on this device, or null if it has not. */
export async function loadChosenCalendarId(uid: string): Promise<string | null> {
  try {
    const stored = await AsyncStorage.getItem(chosenCalendarKey(uid));
    return typeof stored === 'string' && stored.trim() !== '' ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Throws when it could not be saved: the picker reverts and nothing is written
 * into a calendar the next launch would not remember (M5A-R21-001).
 */
export async function saveChosenCalendarId(uid: string, calendarId: string | null): Promise<void> {
  if (calendarId === null) await AsyncStorage.removeItem(chosenCalendarKey(uid));
  else await AsyncStorage.setItem(chosenCalendarKey(uid), calendarId);
}

/** The events this installation wrote for this account, for UC-3.2 (#186) to skip. */
export async function loadWrittenEventIds(uid: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(writtenEventIdsKey(uid));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    // Unreadable means "none recorded", which makes #186 treat our own events
    // as busy — a redundant warning, never a missed one.
    return [];
  }
}

export async function rememberWrittenEventId(uid: string, eventId: string): Promise<void> {
  const current = await loadWrittenEventIds(uid);
  if (current.includes(eventId)) return;
  const next = [...current, eventId].slice(-MAX_WRITTEN_EVENT_IDS);
  try {
    await AsyncStorage.setItem(writtenEventIdsKey(uid), JSON.stringify(next));
  } catch {
    // See `loadWrittenEventIds`: the failure mode is a redundant warning.
  }
}

export async function forgetWrittenEventId(uid: string, eventId: string): Promise<void> {
  const current = await loadWrittenEventIds(uid);
  if (!current.includes(eventId)) return;
  try {
    await AsyncStorage.setItem(
      writtenEventIdsKey(uid),
      JSON.stringify(current.filter((id) => id !== eventId)),
    );
  } catch {
    // Leaving a stale id behind makes #186 skip an event that is no longer
    // ours. Harmless: it is not in the calendar any more either.
  }
}

const pendingUnlinksKey = (uid: string) => `calendar.pendingUnlinks.v1:${uid}`;

export interface PendingUnlink { commitmentId: string; writerId: string }

/**
 * Server links whose phone event this account already removed (M5A-R6-002).
 * Written before the native delete, cleared after the link is gone, so a
 * switch of account in between leaves the account's own record to finish on
 * its next pass instead of a link to an event that no longer exists.
 * Throws when it cannot be read: the caller then deletes nothing.
 */
export async function loadPendingUnlinks(uid: string): Promise<PendingUnlink[]> {
  const raw = await AsyncStorage.getItem(pendingUnlinksKey(uid));
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('pending unlinks unreadable');
  return parsed.filter((row): row is PendingUnlink => typeof row === 'object' && row !== null
    && typeof (row as PendingUnlink).commitmentId === 'string' && typeof (row as PendingUnlink).writerId === 'string');
}

/** Throws when it cannot be written: the native delete then does not happen. */
export async function notePendingUnlink(uid: string, entry: PendingUnlink): Promise<void> {
  const current = await loadPendingUnlinks(uid);
  if (current.some((row) => row.commitmentId === entry.commitmentId && row.writerId === entry.writerId)) return;
  await AsyncStorage.setItem(pendingUnlinksKey(uid), JSON.stringify([...current, entry]));
}

export async function settlePendingUnlink(uid: string, commitmentId: string): Promise<void> {
  try {
    const current = await loadPendingUnlinks(uid);
    await AsyncStorage.setItem(pendingUnlinksKey(uid), JSON.stringify(current.filter((row) => row.commitmentId !== commitmentId)));
  } catch {
    // Left behind, the next pass deletes an already deleted link: idempotent.
  }
}

/** The calendars on this phone the user switched off for busy time. */
export async function loadExcludedCalendarIds(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(EXCLUDED_CALENDAR_IDS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Ids and nothing else, rebuilt on the way out: see `calendarBusy.ts` for
    // why a stored value is never trusted to have the shape we wrote.
    return [...new Set(parsed.filter((id): id is string => typeof id === 'string' && id !== ''))];
  } catch {
    // Unreadable reads as "none switched off": every calendar counts as busy,
    // which costs a redundant hint rather than a missed clash.
    return [];
  }
}

export async function saveExcludedCalendarIds(ids: readonly string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(EXCLUDED_CALENDAR_IDS_KEY, JSON.stringify([...new Set(ids)]));
  } catch {
    // The switch still shows the choice for this session.
  }
}

/**
 * Which device events this phone wrote for which weekly block («ثابت أسبوعي»):
 * `{ blockId, calendarId, eventIds, contentHash, detached? }` per block. Ids
 * and a digest — never a title or an hour.
 *
 * Kept per account. A block's event is removed when the account no longer has
 * the block; without the uid in the key, a second account signing in on this
 * phone would read the first one's links, find none of those blocks, and
 * delete the first person's events out of the phone's calendar.
 */
export const WEEKLY_EVENT_LINKS_KEY = 'calendar.weeklyBlockEvents.v1';

export interface StoredWeeklyEventLink {
  blockId: string;
  calendarId: string;
  eventIds: string[];
  contentHash: string;
  detached?: boolean;
}

function weeklyLinksKey(uid: string): string {
  return `${WEEKLY_EVENT_LINKS_KEY}:${uid}`;
}

function isStoredWeeklyLink(value: unknown): value is StoredWeeklyEventLink {
  if (!value || typeof value !== 'object') return false;
  const link = value as Record<string, unknown>;
  return typeof link.blockId === 'string' && link.blockId !== ''
    && typeof link.calendarId === 'string'
    && Array.isArray(link.eventIds) && link.eventIds.every((id) => typeof id === 'string' && id !== '')
    && typeof link.contentHash === 'string'
    && (link.detached === undefined || typeof link.detached === 'boolean');
}

/**
 * The links, or `null` when storage could not be read. Null is not "none":
 * a pass that read "none" would create a second event for every block.
 */
export async function loadWeeklyEventLinks(uid: string): Promise<StoredWeeklyEventLink[] | null> {
  try {
    const raw = await AsyncStorage.getItem(weeklyLinksKey(uid));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    // Rebuilt field by field: a stored value is never trusted to have the shape we wrote.
    return parsed.filter(isStoredWeeklyLink).map((link) => ({
      blockId: link.blockId,
      calendarId: link.calendarId,
      eventIds: [...link.eventIds],
      contentHash: link.contentHash,
      ...(link.detached ? { detached: true } : {}),
    }));
  } catch {
    return null;
  }
}

/** True when it was written. A false answer stops the pass: see `weeklyEventSync.ts`. */
export async function saveWeeklyEventLinks(uid: string, links: readonly StoredWeeklyEventLink[]): Promise<boolean> {
  try {
    await AsyncStorage.setItem(weeklyLinksKey(uid), JSON.stringify(links));
    return true;
  } catch {
    return false;
  }
}

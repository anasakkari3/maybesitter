/**
 * Reading the append-only domain event log (UC-3.15, #201).
 *
 * UC-1.0b (#141) made `writeDomainDiff` append every `DomainEvent` to
 * `users/{uid}/events`. Until now nothing read it back: the log existed as
 * durability and as an audit trail, and no product surface was built on it.
 * #201 is the first reader, so this module is where "what does the log say"
 * gets decided once instead of in each route.
 *
 * ── Ordering is total, and its tiebreaker is stored ──────────────
 *
 * Newest first by `at`. Several events share one `at` routinely: every event a
 * single command produces is stamped with that command's `now`, so a confirm
 * that activates three commitments writes three events at the same instant.
 * An order that left those three to the storage engine would be free to return
 * them differently on two reads of the same page — and this repository has
 * already shipped that bug once, in a store whose ties broke on a uuid minted
 * *at read time*, so one save's records reordered on every read.
 *
 * The tiebreaker here is the event's own `id`, ascending. It is random, but it
 * is random *once*, when the event was written, and it is stored: the same two
 * events compare the same way forever. That is the property the ordering needs
 * — stability, not meaning.
 *
 * ── The cursor names a record, not a time ───────────────────────
 *
 * `2026-09-14T10:00:00.000Z|<event id>`. A cursor of only the instant could
 * not say *which* of three events sharing that instant a page ended on, so
 * either the next page repeats them or it skips them. Pages here are
 * non-overlapping and lose nothing.
 *
 * ── Why the window grows ─────────────────────────────────────────
 *
 * The storage seam has no `startAfter`, so a page is fetched as "the newest N
 * at or before the cursor's instant" and then trimmed. A tie group wider than
 * the window would be cut by the *engine's* order rather than by ours, so any
 * record sharing the oldest instant in a truncated window is discarded and the
 * window is refetched larger. Every instant strictly newer than that one is
 * known to be complete, because the fetch is a prefix of a descending order.
 */
import { EVENTS, getStorage, userCol, type StorageReader } from '../../storage';
import { requireUserId } from '../../storage/paths';

/** A `DomainEvent` as it was stored, plus the write-time stamp #141 adds. */
export interface DomainEventRecord {
  id: string;
  type: string;
  at: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  recordedAt?: string;
}

export interface EventPage {
  events: DomainEventRecord[];
  /** Pass back as `cursor` for the next page; null when the log is exhausted. */
  nextCursor: string | null;
}

export const MAX_EVENT_PAGE = 50;
/** How wide a single instant's tie group may grow before the page gives up. */
const MAX_WINDOW = 1_000;

/** The total order: newest first, ties broken by the stored event id. */
export function compareEventsNewestFirst(left: DomainEventRecord, right: DomainEventRecord): number {
  if (left.at !== right.at) return left.at < right.at ? 1 : -1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

export function cursorFor(event: DomainEventRecord): string {
  return `${event.at}|${event.id}`;
}

/** `{ at, id }`, or null for anything that is not a cursor this module wrote. */
export function parseCursor(raw: unknown): { at: string; id: string } | null {
  if (typeof raw !== 'string') return null;
  const separator = raw.indexOf('|');
  if (separator <= 0 || separator === raw.length - 1) return null;
  const at = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!Number.isFinite(Date.parse(at))) return null;
  return { at, id };
}

export interface ListEventsOptions {
  limit?: number;
  cursor?: string | null | undefined;
  reader?: StorageReader;
  /**
   * The user collection to page. The domain log unless said otherwise; the
   * plan ledger (#194) is paged by the same order, so one cursor fits both.
   */
  collection?: string;
}

/**
 * One page of this user's events, newest first.
 *
 * An unreadable cursor is treated as no cursor rather than as an error: the
 * worst it can do is show the first page again, and refusing the whole screen
 * over a malformed query string is the louder failure.
 */
export async function listEvents(uid: string, options: ListEventsOptions = {}): Promise<EventPage> {
  requireUserId(uid);
  const limit = clampLimit(options.limit);
  const cursor = parseCursor(options.cursor);
  const reader = options.reader ?? getStorage();
  const path = userCol(uid, options.collection ?? EVENTS);

  let window = limit + 1;
  for (;;) {
    const rows = await reader.list<DomainEventRecord>(path, {
      orderBy: { field: 'at', direction: 'desc' },
      limit: window,
      ...(cursor ? { where: [['at', '<=', cursor.at] as [string, '<=', unknown]] } : {}),
    });
    const fetched = rows.map((row) => row.data).sort(compareEventsNewestFirst);
    /** The engine filled the window, so the log may hold more below it. */
    const filledWindow = rows.length >= window;
    const mayGrow = window < MAX_WINDOW;

    /*
     * Only the oldest instant in a filled window can be missing members, so it
     * is dropped and refetched wider. At `MAX_WINDOW` it is kept instead: a
     * single instant with a thousand events is not a case this product
     * produces, and returning a page ordered by the engine beats returning
     * none at all.
     */
    const oldestAt = fetched.length > 0 ? fetched[fetched.length - 1]!.at : null;
    const complete = filledWindow && mayGrow && oldestAt !== null
      ? fetched.filter((event) => event.at !== oldestAt)
      : fetched;

    /*
     * "After the cursor" is decided by the page order, not by comparing the
     * cursor strings. Newest-first means a later record has a *smaller* `at`,
     * so a lexicographic `>` on `at|id` would keep the tie group and throw
     * away every older day behind it — which is exactly how a walk of the log
     * silently loses entries.
     */
    const after = cursor === null
      ? complete
      : complete.filter((event) => compareEventsNewestFirst(asRecord(cursor), event) < 0);

    if (after.length < limit && filledWindow && mayGrow) {
      window = Math.min(window * 4, MAX_WINDOW);
      continue;
    }

    const page = after.slice(0, limit);
    const last = page[page.length - 1];
    const hasMore = after.length > limit || filledWindow;
    return { events: page, nextCursor: last && hasMore ? cursorFor(last) : null };
  }
}

/** Oldest first, with the same stored tiebreaker the page order uses. */
export function compareEventsOldestFirst(left: DomainEventRecord, right: DomainEventRecord): number {
  if (left.at !== right.at) return left.at < right.at ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * Every event in `[fromInclusive, toExclusive)`, oldest first.
 *
 * Bounded by `limit` — #201 fixes it at 500 for a week — because a summary is
 * a small number over a small window and an unbounded read of somebody's whole
 * history to compute it is how a route stops answering for a heavy account.
 */
export async function listEventsInRange(
  uid: string,
  fromInclusive: string,
  toExclusive: string,
  limit: number,
  reader: StorageReader = getStorage(),
  collection: string = EVENTS,
): Promise<DomainEventRecord[]> {
  requireUserId(uid);
  const rows = await reader.list<DomainEventRecord>(userCol(uid, collection), {
    orderBy: { field: 'at', direction: 'asc' },
    limit,
    where: [
      ['at', '>=', fromInclusive] as [string, '>=', unknown],
      ['at', '<', toExclusive] as [string, '<', unknown],
    ],
  });
  return rows.map((row) => row.data).sort(compareEventsOldestFirst);
}

/**
 * Every event of one `type` in `[fromInclusive, toExclusive)`, oldest first.
 *
 * The same read as `listEventsInRange`, narrowed by the engine rather than
 * after it: `limit` bounds the events of this type, not the whole log, so a
 * reader that needs only completions neither pays for every other event in
 * the window nor has its bound filled by them (#443).
 *
 * In Firestore this is an equality on `type` plus a range and an order on
 * `at`, which needs the composite index `events (type ASC, at ASC)` declared
 * in `firestore.indexes.json`; `tests/storage/firestoreIndexes.test.ts` reads
 * this call to keep the two in step. A document with no `type` matches no
 * type, in the memory adapter as in Firestore.
 */
export async function listEventsOfTypeInRange(
  uid: string,
  type: string,
  fromInclusive: string,
  toExclusive: string,
  limit: number,
  reader: StorageReader = getStorage(),
): Promise<DomainEventRecord[]> {
  requireUserId(uid);
  const rows = await reader.list<DomainEventRecord>(userCol(uid, EVENTS), {
    where: [['type', '==', type], ['at', '>=', fromInclusive], ['at', '<', toExclusive]],
    orderBy: { field: 'at', direction: 'asc' },
    limit,
  });
  return rows.map((row) => row.data).sort(compareEventsOldestFirst);
}

/** Just enough of a record for the comparator to place the cursor. */
function asRecord(cursor: { at: string; id: string }): DomainEventRecord {
  return { id: cursor.id, at: cursor.at, type: '', aggregateId: '', payload: {} };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined) return 20;
  if (!Number.isFinite(raw)) return 20;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_EVENT_PAGE);
}

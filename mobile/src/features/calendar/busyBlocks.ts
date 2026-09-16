/**
 * The only place in this app that ever touches a calendar event (UC-3.2, #186).
 *
 * ── Why "the only place" is the point ────────────────────────────
 *
 * UC-3.1 (#185) wrote events and asked whether they were still there. It never
 * read one, so "MaybeSitter cannot see what is in your calendar" was something
 * the platform enforced rather than something the code promised.
 *
 * Reading busy time gives that up. `expo-calendar` returns whole events —
 * `title`, `notes`, `location`, an attendee list, an organizer — into ordinary
 * JavaScript memory, and from there anything is one careless `JSON.stringify`
 * away from a log line, an analytics event or a request body. So the guarantee
 * is re-established here instead: `toBusyBlocks` is the single function every
 * event passes through, and what comes out is four fields.
 *
 *   `{ nativeId, startAt, endAt, allDay }`
 *
 * No caller of this module is handed an event. `deviceCalendar.fetchBusyBlocks`
 * lists them, passes them straight here, and returns what comes back; nothing
 * upstream of that has a type that could hold a title. The route on the other
 * end refuses a body that carries one, so the rule is enforced twice and
 * neither end trusts the other.
 *
 * ── An occurrence is (id, start), not id ─────────────────────────
 *
 * On iOS every instance of a weekly event comes back carrying the *same* `id`.
 * Deduplicating on the id alone would collapse a whole term's lectures into one
 * block and let the planner schedule work through every one after the first.
 * The pair is also what the server's `blockId` hashes, so the two agree about
 * what one block is.
 *
 * ── Declined events, and the platform that cannot say ────────────
 *
 * `isCurrentUser` on an attendee is iOS-only, so "did I decline this?" is a
 * question only iOS can answer. The declined ids are resolved by the caller —
 * it needs an async lookup per event and this function is pure — and on Android
 * the set is simply empty, so a declined meeting counts as busy. That is the
 * conservative direction: a redundant conflict hint, never a missed one.
 */

/** The complete list of keys a busy block has. Asserted, not described. */
export const BUSY_BLOCK_KEYS = ['nativeId', 'startAt', 'endAt', 'allDay'] as const;

/** What this app knows about one interval of somebody's time. */
export interface DeviceBusyBlock {
  /** The calendar's own id for the event. Never sent to a server unhashed. */
  readonly nativeId: string;
  readonly startAt: string;
  /** Exclusive. */
  readonly endAt: string;
  readonly allDay: boolean;
}

/** The url this app puts on the events it writes, on iOS (UC-3.1, #185). */
export const OWN_EVENT_URL_PREFIX = 'maybesitter://commitments/';

/**
 * An event as `expo-calendar` hands it over.
 *
 * Deliberately open. It is not a description of what this app wants — it is an
 * acknowledgement that the object really does carry a title and a guest list,
 * which is exactly why the mapping below is written as a positive allowlist
 * rather than as a `delete event.title`.
 */
export interface CalendarEventLike {
  readonly id?: unknown;
  readonly startDate?: unknown;
  readonly endDate?: unknown;
  readonly allDay?: unknown;
  readonly availability?: unknown;
  readonly status?: unknown;
  readonly url?: unknown;
  readonly [key: string]: unknown;
}

export interface ToBusyBlocksOptions {
  /** The events this installation wrote, from `calendar.writtenEventIds.v1`. */
  readonly ownEventIds: ReadonlySet<string>;
  /** iOS only; empty everywhere else. See the header. */
  readonly declinedEventIds?: ReadonlySet<string>;
  /** Anything finished before this is not busy time. */
  readonly now: Date;
}

/** An ISO instant, or null when the platform gave something unusable. */
function instantOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function toBusyBlocks(
  events: readonly CalendarEventLike[],
  options: ToBusyBlocksOptions,
): DeviceBusyBlock[] {
  const declined = options.declinedEventIds ?? new Set<string>();
  const nowMs = options.now.getTime();
  const seen = new Set<string>();
  const blocks: DeviceBusyBlock[] = [];

  for (const event of events) {
    const nativeId = textOf(event.id);
    if (nativeId === '') continue;

    // Ours. Counting a commitment's own entry as busy would tell somebody their
    // 15:00 collides with their 15:00.
    if (options.ownEventIds.has(nativeId)) continue;
    if (textOf(event.url).startsWith(OWN_EVENT_URL_PREFIX)) continue;

    // `free` is the calendar's own word for "this is in my diary and I am not
    // busy". `tentative` is not: a maybe is still a claim on the hour.
    if (textOf(event.availability) === 'free') continue;
    if (textOf(event.status) === 'canceled') continue;
    if (declined.has(nativeId)) continue;

    const startAt = instantOf(event.startDate);
    const endAt = instantOf(event.endDate);
    if (startAt === null || endAt === null) continue;
    // Half-open, like every interval in this product: an event that ends where
    // it starts occupies nothing.
    if (Date.parse(endAt) <= Date.parse(startAt)) continue;
    if (Date.parse(endAt) <= nowMs) continue;

    const occurrence = `${nativeId} @ ${startAt}`;
    if (seen.has(occurrence)) continue;
    seen.add(occurrence);

    // Written out field by field rather than spread or picked from a list, so
    // that "only these four" is a property of this literal. A `pick(event,
    // KEYS)` helper would put the guarantee one indirection away from the place
    // somebody reads when they ask what leaves the phone.
    blocks.push({
      nativeId,
      startAt,
      endAt,
      allDay: event.allDay === true,
    });
  }

  return blocks.sort((left, right) => {
    const delta = Date.parse(left.startAt) - Date.parse(right.startAt);
    if (delta !== 0) return delta;
    return left.nativeId < right.nativeId ? -1 : left.nativeId > right.nativeId ? 1 : 0;
  });
}

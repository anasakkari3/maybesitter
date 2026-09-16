/**
 * One commitment, as an entry in somebody's calendar (UC-3.1, #185).
 *
 * Pure: a commitment and a zone in, a draft or `null` out. No native module, no
 * clock, no storage. That is what lets every branch below be a test rather than
 * a thing somebody checks by looking at their phone — which matters here more
 * than usual, because the rest of this feature genuinely cannot be proven
 * without a device.
 *
 * ── The three shapes, and the one that writes nothing ────────────
 *
 *   a day          → an all-day entry on that day
 *   a start-to-end → an event covering exactly that range
 *   a single time  → an event starting then, `DEFAULT_MINUTES` long
 *   no time at all → `null`, and nothing is written
 *
 * The last is not an edge case; it is most of a backlog. "Buy milk" belongs on
 * Today and belongs nowhere in a calendar, because a calendar entry is a claim
 * about *when*, and the user made no such claim. Writing it at an invented hour
 * would put a thing they never scheduled in front of everyone they share the
 * calendar with.
 *
 * ── Why a single time gets a default length ──────────────────────
 *
 * `endAt: null` means the commitment names no end (#185). A calendar has no way
 * to draw a point in time: every event has a start and an end, and an event
 * with both equal is either invisible or rendered as an arbitrary block by the
 * OS anyway. So the default is picked here, in the open, by the one module that
 * is translating *into* a calendar's vocabulary — rather than by giving every
 * commitment in the domain a thirty-minute duration nobody asked for.
 *
 * ── The content hash ─────────────────────────────────────────────
 *
 * A digest of everything this module puts into the calendar. The sync service
 * compares it against the hash on the stored link and does nothing when they
 * match, so opening the app does not rewrite every event on every launch —
 * which on a shared calendar is a notification for everybody, every time.
 *
 * It is computed over the *draft*, not over the commitment, so a change the
 * calendar cannot see (a description, a priority) is correctly a no-op.
 */
import type { Commitment } from '../../api/schemas/common';
import { offsetMinutes } from '../../lib/time/zoneOffset';

/** How long an event is when the commitment names only a start. */
export const DEFAULT_MINUTES = 30;

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

/** What the user reads in their calendar. Nothing here is invented. */
export const EVENT_NOTES = 'Added by MaybeSitter.';

export interface EventDraft {
  title: string;
  notes: string;
  startDate: Date;
  endDate: Date;
  allDay: boolean;
  timeZone: string;
  url: string;
  /** A digest of every field above, so an unchanged event is not rewritten. */
  contentHash: string;
}

/**
 * The instant local midnight of `instant`'s day in `timeZone` falls at.
 *
 * An all-day entry is a *day*, and which day depends on where the user is:
 * 21:00 UTC is already tomorrow in Asia/Jerusalem. `offsetMinutes` is the one
 * offset helper in this app — Hermes cannot be asked for an offset by name, see
 * `lib/time/zoneOffset.ts` — and this is the only arithmetic done with it here.
 */
function startOfLocalDay(instant: Date, timeZone: string): Date {
  const shifted = instant.getTime() + offsetMinutes(instant, timeZone) * MS_PER_MINUTE;
  const midnightAsUtc = Math.floor(shifted / MS_PER_DAY) * MS_PER_DAY;
  // Resolved against the offset at the answer rather than at the guess, so a
  // day that begins on the far side of a clock change still begins at midnight.
  const guess = new Date(midnightAsUtc - offsetMinutes(instant, timeZone) * MS_PER_MINUTE);
  return new Date(midnightAsUtc - offsetMinutes(guess, timeZone) * MS_PER_MINUTE);
}

/**
 * A stable digest of the draft.
 *
 * Deliberately not a cryptographic hash. Nothing here is a secret and nothing
 * is being authenticated — the question is only "is this the same event I last
 * wrote?" — and `expo-crypto`'s digest is async, which would make every caller
 * of this pure function async for no gain. FNV-1a over the joined fields is
 * stable across runs and across engines, which is what the comparison needs.
 */
export function contentHashOf(parts: readonly string[]): string {
  const text = parts.join(' ');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // `Math.imul` rather than `*`: the product overflows 32 bits on the second
    // character, and `*` would silently start doing float arithmetic.
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * The event for a commitment, or `null` when it names no time.
 *
 * `timeZone` is the commitment's own — the zone the user was in when they said
 * it — falling back to the device's only when the commitment carries none. It
 * is *not* the device's current zone: a commitment made in Tel Aviv for 09:00
 * is at 09:00 there whatever airport its owner reads it in.
 */
export function draftFor(commitment: Commitment, deviceTimeZone: string): EventDraft | null {
  const { timeSpec } = commitment;
  const start = timeSpec.dueAt ?? timeSpec.remindAt;
  if (start === null) return null;

  const timeZone = timeSpec.timezone || deviceTimeZone;
  const startInstant = new Date(start);
  if (Number.isNaN(startInstant.getTime())) return null;

  const { startDate, endDate, allDay } = boundsFor(timeSpec, startInstant, timeZone);

  const title = commitment.title;
  const url = `maybesitter://commitments/${encodeURIComponent(commitment.id)}`;
  return {
    title,
    notes: EVENT_NOTES,
    startDate,
    endDate,
    allDay,
    timeZone,
    url,
    contentHash: contentHashOf([
      title,
      startDate.toISOString(),
      endDate.toISOString(),
      String(allDay),
      timeZone,
      EVENT_NOTES,
    ]),
  };
}

function boundsFor(
  timeSpec: Commitment['timeSpec'],
  startInstant: Date,
  timeZone: string,
): { startDate: Date; endDate: Date; allDay: boolean } {
  if (timeSpec.allDay) {
    // Midnight to midnight, in the commitment's own zone. Both platforms take a
    // start and an end for an all-day entry; giving them the same instant twice
    // produces an entry with no day at all.
    const startDate = startOfLocalDay(startInstant, timeZone);
    // The midnight after the first day. Midday of the following day is the
    // probe, so a clock change on that night cannot land it back on the day it
    // started. This is what a commitment naming no end is worth: one day.
    const nextMidnight = startOfLocalDay(new Date(startDate.getTime() + MS_PER_DAY + MS_PER_DAY / 2), timeZone);

    // `endAt` is **exclusive**, here as everywhere: `defaultTimeSpec` fixes
    // `[start, end)` and refuses an end that is not strictly after its start,
    // so the only spelling a one-day commitment has is the next midnight. Read
    // as the last *included* day it rendered as two — and the same day written
    // with `endAt: null` rendered as one, which is two entries for one fact in
    // a calendar other people can see.
    const end = timeSpec.endAt === null ? null : new Date(timeSpec.endAt);
    const exclusive = end !== null && !Number.isNaN(end.getTime())
      ? startOfLocalDay(end, timeZone)
      : null;

    // A stored end inside the first day describes no day at all. The domain
    // refuses one — an all-day end has to be a local midnight — so this is the
    // floor under a record that came from somewhere the domain did not write,
    // and an invisible entry is the one outcome worth ruling out by hand.
    const endDate = exclusive !== null && exclusive.getTime() > startDate.getTime()
      ? exclusive
      : nextMidnight;
    return { startDate, endDate, allDay: true };
  }

  if (timeSpec.endAt !== null) {
    const endInstant = new Date(timeSpec.endAt);
    // The domain refuses an end that is not after its start, so this branch is
    // reached only with a real range. The guard is for a response that came
    // from somewhere the domain did not write.
    if (!Number.isNaN(endInstant.getTime()) && endInstant.getTime() > startInstant.getTime()) {
      return { startDate: startInstant, endDate: endInstant, allDay: false };
    }
  }

  return {
    startDate: startInstant,
    endDate: new Date(startInstant.getTime() + DEFAULT_MINUTES * MS_PER_MINUTE),
    allDay: false,
  };
}

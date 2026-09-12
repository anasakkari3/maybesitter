/**
 * Does the time the user picked collide with a time they are already busy?
 *
 * ── Half-open intervals, matching the server ─────────────────────
 *
 * `[start, end)`. Two intervals overlap when `a.start < b.end &&
 * b.start < a.end` — strict `<` on **both** sides, so back-to-back blocks
 * (10:00–11:00 and 11:00–12:00) do not conflict. That is the convention
 * `lib/planning/shared/time.ts` `intervalsOverlap` fixed for the whole
 * product, and this mirrors it deliberately: a demo that used `<=` on one side
 * would refuse a time the real planner allows, and the two would each be
 * self-consistent while disagreeing.
 *
 * A zero-length interval is the empty set and intersects nothing. The textbook
 * formula gets that wrong — it reports `[09:00, 09:00)` as overlapping
 * anything containing that instant — so, like the server, this checks
 * positivity first and answers the mathematically honest way.
 *
 * Nothing here reads an event title. The whole point of the scope
 * justification is that only start and end times are used, and a function that
 * cannot see a title cannot leak one.
 */

export interface BusyInterval {
  /** ISO-8601 instant. */
  start: string;
  end: string;
}

function ms(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error('expected an ISO-8601 instant');
  return parsed;
}

export function isPositiveInterval(interval: BusyInterval): boolean {
  return ms(interval.end) > ms(interval.start);
}

export function intervalsOverlap(a: BusyInterval, b: BusyInterval): boolean {
  if (!isPositiveInterval(a) || !isPositiveInterval(b)) return false;
  return ms(a.start) < ms(b.end) && ms(b.start) < ms(a.end);
}

/**
 * Every busy interval the candidate collides with, in the order given.
 *
 * A list rather than a boolean: the screen tells the user *what* they are busy
 * with the time of, and "you have something else then" with no detail is the
 * kind of warning people learn to dismiss.
 */
export function findOverlaps(busy: readonly BusyInterval[], candidate: BusyInterval): BusyInterval[] {
  if (!isPositiveInterval(candidate)) return [];
  return busy.filter(interval => intervalsOverlap(interval, candidate));
}

/**
 * Merges touching or overlapping intervals, so "busy times" reads as a few
 * blocks rather than one row per calendar. Freebusy returns one range per
 * calendar, and two calendars covering the same meeting would otherwise show
 * it twice.
 *
 * Abutting intervals *are* merged here, unlike the overlap rule: for display,
 * 09:00–10:00 followed by 10:00–11:00 is one busy block of two hours.
 */
export function mergeBusy(busy: readonly BusyInterval[]): BusyInterval[] {
  const positive = busy.filter(isPositiveInterval).slice().sort((a, b) => ms(a.start) - ms(b.start));
  const merged: BusyInterval[] = [];
  for (const interval of positive) {
    const last = merged[merged.length - 1];
    if (last && ms(interval.start) <= ms(last.end)) {
      if (ms(interval.end) > ms(last.end)) merged[merged.length - 1] = { start: last.start, end: interval.end };
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

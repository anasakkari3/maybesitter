/**
 * Whether free time can be told, and for which part of a day (M4a R003/R004).
 *
 * ── Never fail open (M4A-R7-002) ─────────────────────────────────
 *
 * "Nothing is busy at 15:00" is a claim about every place busy time could be.
 * It holds only for the stretch that every applicable source has actually
 * read: the phone's calendar for the window its last read covered, Google for
 * its honest window, the server's ICS feeds only while each one is healthy,
 * and the server's answer up to its cutoff, less any range a malformed legacy
 * row makes unknown. A source that failed makes the place "unknown"; one
 * still loading makes it "loading", unless what has answered already leaves
 * part of it uncovered. Neither is ever drawn as free.
 *
 * ── A day may be known in part ───────────────────────────────────
 *
 * A device read cut at 13:00 says what is free before 13:00 and nothing
 * after. The day's list shows the gaps it can vouch for and the unknown line
 * beside them; a total, and a cell's bar in the 4-week view, need the whole
 * evaluated stretch to be known.
 */
import {
  covers,
  dayBounds,
  dayWindow,
  evaluatedInterval,
  freeGaps,
  freeMinutes,
  mergeIntervals,
  subtract,
  type Gap,
  type Interval,
} from './freeTime';

export type FreeState = 'loading' | 'unknown' | 'partial' | 'full';

export interface FreeSources {
  /** Something applicable has not answered yet. */
  readonly pending: boolean;
  /** Something applicable failed. */
  readonly failed: boolean;
  /** The span the server was asked about. */
  readonly range: Interval;
  /** The phone's calendar: applicable when reading is on and consented. */
  readonly device: { readonly applicable: boolean; readonly coverage: Interval | null };
  /** Google Calendar: applicable while connected with the calendar feature. */
  readonly google: { readonly connected: boolean; readonly coverage: Interval | null };
  /** The server's ICS and manual time. */
  readonly server: {
    /** Every ICS feed is `ok`, with a window. */
    readonly feedsOk: boolean;
    /** Each ICS feed's window: what its last refresh read. */
    readonly icsWindows: readonly Interval[];
    /** Blocks from here on were omitted (`complete: false`). */
    readonly cutoff: number | null;
    readonly unknown: readonly Interval[];
  };
}

function intersect(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of mergeIntervals(a)) {
    for (const y of mergeIntervals(b)) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return mergeIntervals(out);
}

/**
 * The time every source that has answered vouches for. A source still
 * pending does not narrow it yet (`dayFree` says "loading" for that); a failed
 * one leaves nothing known.
 */
export function knownTime(sources: FreeSources): Interval[] {
  if (sources.failed || !sources.server.feedsOk) return [];
  let known: Interval[] = [sources.range];
  if (sources.server.cutoff !== null) known = intersect(known, [{ start: sources.range.start, end: sources.server.cutoff }]);
  for (const window of sources.server.icsWindows) known = intersect(known, [window]);
  if (sources.device.applicable) known = sources.device.coverage ? intersect(known, [sources.device.coverage]) : [];
  if (sources.google.connected) known = sources.google.coverage ? intersect(known, [sources.google.coverage]) : [];
  return subtract(known, sources.server.unknown);
}

export interface DayFree {
  readonly state: FreeState;
  /** The gaps the known part of the day vouches for. */
  readonly gaps: Gap[];
  /** Minutes free over the whole evaluated day; null unless the whole of it is known. */
  readonly totalMinutes: number | null;
}

/**
 * Free time on day `key`. `occupied` is everything that occupies time, from
 * every source; `known` is `knownTime(sources)`.
 */
export function dayFree(
  sources: FreeSources,
  known: readonly Interval[],
  occupied: readonly Interval[],
  key: string,
  timeZone: string,
  sleep: { start: string; end: string } | null,
  now: number,
): DayFree {
  // A failure is unknown at once; so is a day an answered source already does
  // not cover, whatever else is still loading. Only a day that would be fully
  // known once the rest answers is "loading".
  if (sources.failed) return { state: 'unknown', gaps: [], totalMinutes: null };
  const day = dayBounds(key, timeZone);
  const evaluated = evaluatedInterval(day, now);
  if (!evaluated) return { state: sources.pending ? 'loading' : 'full', gaps: [], totalMinutes: sources.pending ? null : 0 };
  if (sources.pending) {
    return { state: covers(known, evaluated) ? 'loading' : 'unknown', gaps: [], totalMinutes: null };
  }
  const window = dayWindow(key, timeZone, sleep);
  if (covers(known, evaluated)) {
    const gaps = freeGaps(occupied, day, window, now);
    return { state: 'full', gaps, totalMinutes: freeMinutes(gaps) };
  }
  const knownWindow = intersect(window, known);
  const gaps = freeGaps(occupied, day, knownWindow, now);
  return { state: intersect([evaluated], known).length > 0 ? 'partial' : 'unknown', gaps, totalMinutes: null };
}

/** Whether Google's window covers the whole evaluated part of day `key`. */
export function googleCovers(coverage: Interval | null, key: string, timeZone: string, now: number): boolean {
  const evaluated = evaluatedInterval(dayBounds(key, timeZone), now);
  if (!evaluated) return true;
  return coverage !== null && coverage.start <= evaluated.start && evaluated.end <= coverage.end;
}

/** Google's normal look-ahead: the server reads 14 × 24 hours from the sync. */
const GOOGLE_NORMAL_MS = 14 * 24 * 60 * 60_000;

/** Whether Google's window ends at its normal 14 days, rather than earlier or not at all. */
export function googleWindowIsNormal(coverage: Interval | null): boolean {
  return coverage !== null && coverage.end - coverage.start >= GOOGLE_NORMAL_MS - 60_000;
}

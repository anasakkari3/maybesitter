/**
 * The Plan tab's day as a proportional timeline (Stitch `02-plan`).
 *
 * ── Equal hours, honest heights ──────────────────────────────────
 *
 * Every hour is the same height, so a gap on screen is a gap in the day. A
 * block that has a start and an end — busy time from the person's calendar,
 * a weekly fixed block — is exactly as tall as it lasts. A commitment names an
 * instant and no end (see `conflicts.ts`), so it is a marker at its time with
 * no height of its own: drawing it as a block would invent a duration the
 * person never gave.
 *
 * ── Labels need room the hours do not give ───────────────────────
 *
 * A fifteen-minute block is fourteen points tall, and a marker is a line. Their
 * labels still need a line of text and a 44-point target, so each entry also
 * has a *visual* extent — at least what its label takes — and entries whose
 * visual extents overlap are set side by side in lanes rather than on top of
 * each other. The block itself keeps its true height; only the label may run
 * past it.
 *
 * Everything here is pure and works in minutes from the selected day's local
 * midnight, so it can be tested without a clock or a renderer.
 */
import { localDateTimeFor } from '../capture/localInstant';

/** One hour on screen (Stitch: 56 px). */
export const HOUR_HEIGHT = 56;
/** The window drawn when the day holds nothing earlier or later (Stitch: 08:00–23:00). */
export const DEFAULT_FROM_HOUR = 8;
export const DEFAULT_TO_HOUR = 23;

const DAY_MINUTES = 24 * 60;

/**
 * Minutes from the start of `day` (a `YYYY-MM-DD` key) to `iso`, on the clock
 * in `timeZone`. An instant on an earlier day is 0 and one on a later day is
 * the end of the day, so a block that crosses midnight is drawn up to the
 * edge of the day it is on, not wrapped onto the morning.
 */
export function minuteOfDay(iso: string, day: string, timeZone: string): number {
  const local = localDateTimeFor(new Date(iso), timeZone);
  const date = local.slice(0, 10);
  if (date < day) return 0;
  if (date > day) return DAY_MINUTES;
  return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
}

export interface TimelineSpan {
  key: string;
  /** Minutes from local midnight. */
  start: number;
  /** Null for a marker: an instant with no duration. */
  end: number | null;
  /** The least height its label needs, in points. */
  minVisual: number;
}

/** The hours to draw: the default window, widened to whatever the day holds. */
export function hourWindow(spans: readonly TimelineSpan[]): { from: number; to: number } {
  let from = DEFAULT_FROM_HOUR;
  let to = DEFAULT_TO_HOUR;
  for (const span of spans) {
    from = Math.min(from, Math.floor(span.start / 60));
    const last = span.end ?? span.start;
    // A marker in the last hour still needs that hour drawn under it.
    to = Math.max(to, span.end === null ? Math.floor(last / 60) + 1 : Math.ceil(last / 60));
  }
  return { from: Math.max(0, from), to: Math.min(24, Math.max(to, from + 1)) };
}

/** Where a minute of the day sits, in points from the top of the drawn window. */
export function yOf(minute: number, fromHour: number): number {
  return ((minute - fromHour * 60) * HOUR_HEIGHT) / 60;
}

export interface PlacedSpan {
  key: string;
  top: number;
  /** The true height: the duration, or 0 for a marker. */
  height: number;
  /** The height reserved for its label: never less than `height`. */
  visual: number;
  lane: number;
  lanes: number;
}

/**
 * Positions, and lanes for whatever would otherwise overlap.
 *
 * Entries are taken in order of their top edge. Each goes into the first lane
 * whose last entry has ended (visually) by its top; a run of entries that
 * overlap one another shares one lane count, so each is as wide as the
 * busiest moment of its run allows and no wider.
 */
export function placeSpans(spans: readonly TimelineSpan[], fromHour: number): PlacedSpan[] {
  const sized = spans
    .map((span) => {
      const top = yOf(span.start, fromHour);
      const height = span.end === null ? 0 : Math.max(0, yOf(span.end, fromHour) - top);
      return { key: span.key, top, height, visual: Math.max(height, span.minVisual) };
    })
    .sort((a, b) => a.top - b.top || b.visual - a.visual);

  const placed: PlacedSpan[] = [];
  let run: PlacedSpan[] = [];
  let runEnd = -Infinity;
  let laneEnds: number[] = [];
  const closeRun = () => {
    const lanes = laneEnds.length;
    for (const entry of run) entry.lanes = lanes;
    run = [];
    laneEnds = [];
  };
  for (const entry of sized) {
    if (entry.top >= runEnd) {
      closeRun();
      runEnd = -Infinity;
    }
    let lane = laneEnds.findIndex((end) => end <= entry.top);
    if (lane < 0) {
      lane = laneEnds.length;
      laneEnds.push(0);
    }
    laneEnds[lane] = entry.top + entry.visual;
    runEnd = Math.max(runEnd, entry.top + entry.visual);
    const next: PlacedSpan = { ...entry, lane, lanes: 1 };
    run.push(next);
    placed.push(next);
  }
  closeRun();
  return placed;
}

export type DayLoad = 'light' | 'normal' | 'full';

/**
 * The one word under each day in the strip, from how many things are on it —
 * commitments, busy blocks and weekly fixed time alike. Nothing is "light"
 * because it is empty of commitments while a calendar fills it.
 */
export function dayLoad(count: number): DayLoad {
  return count === 0 ? 'light' : count < 3 ? 'normal' : 'full';
}

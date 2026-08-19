/**
 * Time primitives shared by all three Sprint 07 tracks.
 *
 * This module exists because of a lesson the roadmap records from Sprint 06:
 * two independent implementations of a *judgement* check each other, but two
 * independent copies of *data or arithmetic* are a gap waiting for whichever
 * caller falls into it. Three copies of a connective lexicon disagreed on 20 of
 * 31 titles there. Wall-clock-to-instant conversion across a DST boundary is
 * the same shape of hazard and a worse one: #29 normalizes windows, #30 places
 * work inside them, and #31 asserts what should happen on the two days a year
 * the offset moves. Three readings of "what time is 02:30 on the spring-forward
 * date" would leave three green suites and one wrong plan.
 *
 * So the arithmetic lives here once, and the three tracks import it. What they
 * do *not* share is the judgement built on top: whether a given set of
 * constraints is feasible is decided independently by #29's validator and #31's
 * oracle, which is the comparison the cross-track test exists to make.
 *
 * Nothing here reads an ambient clock. Every function takes the instants it
 * operates on, per `PLANNING_PERSISTENCE_POLICY.noAmbientClock` — a planner
 * that could call `Date.now()` would produce a different plan on every run and
 * no determinism test could catch it.
 */

import type { Instant, LocalTimeResolution, TimeInterval } from '../../../src/contracts/v1/planningContracts';

/** Wall-clock fields, as they read on a clock face in some zone. */
export interface WallClockParts {
  readonly year: number;
  /** 1-12. One-based, unlike `Date`'s month, because these come from humans. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/* ── Instants ────────────────────────────────────────────────────── */

/**
 * Parse an ISO-8601 instant to epoch milliseconds.
 *
 * Throws on anything unparseable rather than returning `NaN`. `NaN` propagates
 * silently through every comparison as `false`, so a malformed instant would
 * turn "this item conflicts" into "this item does not conflict" — the failure
 * would look like a scheduling decision rather than a parse error.
 */
export function toEpochMs(instant: Instant): number {
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) {
    throw new TypeError(`not a parseable ISO-8601 instant: ${JSON.stringify(instant)}`);
  }
  return ms;
}

/** Epoch milliseconds to a canonical UTC ISO-8601 string. */
export function toInstant(epochMs: number): Instant {
  if (!Number.isFinite(epochMs)) {
    throw new TypeError(`not a finite epoch value: ${String(epochMs)}`);
  }
  return new Date(epochMs).toISOString();
}

export function addMinutes(instant: Instant, minutes: number): Instant {
  return toInstant(toEpochMs(instant) + minutes * MS_PER_MINUTE);
}

export function minutesBetween(from: Instant, to: Instant): number {
  return (toEpochMs(to) - toEpochMs(from)) / MS_PER_MINUTE;
}

/* ── Intervals ───────────────────────────────────────────────────── */

/**
 * Whether two half-open intervals `[start, end)` overlap.
 *
 * The single definition of the sprint's central convention. Strict `<` on both
 * sides is the whole content of "end times are exclusive": intervals that abut
 * share the instant one ends and the other begins, and do not conflict.
 *
 * Every conflict check in every track goes through this function. An
 * implementation that inlined `<=` on one side would produce a scheduler that
 * refuses to place back-to-back work and a validator that permits it, and both
 * would be self-consistent.
 *
 * The emptiness guard is not defensive tidying. `a.start < b.end &&
 * b.start < a.end` is the textbook formula and it is *wrong* for a zero-length
 * interval: `[09:00, 09:00)` is the empty set and intersects nothing, but the
 * formula reports it as overlapping any interval containing that instant. Both
 * readings are defensible right up until two tracks pick different ones — so
 * this returns the mathematically honest answer, and a degenerate interval is
 * caught where it belongs, by the `INVALID_INTERVAL` check that runs before
 * anything is scheduled. That division is deliberate: this function answers
 * "do these two occupy common time", not "is this input well-formed".
 */
export function intervalsOverlap(a: TimeInterval, b: TimeInterval): boolean {
  if (!isPositiveInterval(a) || !isPositiveInterval(b)) return false;
  return toEpochMs(a.startsAt) < toEpochMs(b.endsAt) && toEpochMs(b.startsAt) < toEpochMs(a.endsAt);
}

/** True when `endsAt` is strictly after `startsAt`. See `INVALID_INTERVAL`. */
export function isPositiveInterval(interval: TimeInterval): boolean {
  return toEpochMs(interval.endsAt) > toEpochMs(interval.startsAt);
}

export function intervalMinutes(interval: TimeInterval): number {
  return minutesBetween(interval.startsAt, interval.endsAt);
}

/**
 * The overlapping part of two intervals, or null when they do not overlap.
 * Abutting intervals return null rather than a zero-length interval, keeping
 * the "no zero-length intervals" rule of `TimeInterval` true of every value
 * this module produces.
 */
export function intersectIntervals(a: TimeInterval, b: TimeInterval): TimeInterval | null {
  const startsAt = Math.max(toEpochMs(a.startsAt), toEpochMs(b.startsAt));
  const endsAt = Math.min(toEpochMs(a.endsAt), toEpochMs(b.endsAt));
  if (endsAt <= startsAt) return null;
  return { startsAt: toInstant(startsAt), endsAt: toInstant(endsAt) };
}

/**
 * Subtract a set of intervals from one interval, returning what remains.
 *
 * Used to turn "this working window, minus the meetings inside it" into the
 * free runs a scheduler may place work in. Results are sorted and disjoint, and
 * zero-length remnants are dropped rather than returned.
 */
export function subtractIntervals(
  base: TimeInterval,
  cuts: readonly TimeInterval[],
): TimeInterval[] {
  const ordered = cuts
    .map((cut) => intersectIntervals(base, cut))
    .filter((cut): cut is TimeInterval => cut !== null)
    .sort((left, right) => toEpochMs(left.startsAt) - toEpochMs(right.startsAt));

  const remaining: TimeInterval[] = [];
  let cursor = toEpochMs(base.startsAt);
  const end = toEpochMs(base.endsAt);

  for (const cut of ordered) {
    const cutStart = toEpochMs(cut.startsAt);
    const cutEnd = toEpochMs(cut.endsAt);
    if (cutStart > cursor) {
      remaining.push({ startsAt: toInstant(cursor), endsAt: toInstant(Math.min(cutStart, end)) });
    }
    cursor = Math.max(cursor, cutEnd);
    if (cursor >= end) break;
  }
  if (cursor < end) {
    remaining.push({ startsAt: toInstant(cursor), endsAt: toInstant(end) });
  }
  return remaining.filter(isPositiveInterval);
}

/* ── Zones ───────────────────────────────────────────────────────── */

/**
 * The UTC offset in milliseconds that `timeZone` was at `epochMs`.
 *
 * Read from `Intl` rather than from a table, so it tracks whatever tzdata the
 * runtime ships. `longOffset` is used because it yields the offset directly
 * ("GMT-04:00") instead of requiring a difference of two formatted timestamps,
 * which is the formulation that loses the sign near the transition.
 */
export function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(new Date(epochMs));
  const name = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  // Bare "GMT" is what the formatter emits at offset zero; treat it as 0 rather
  // than as a parse failure, which would make every UTC computation silently
  // fall through to the same value by accident instead of by rule.
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes) * MS_PER_MINUTE;
}

/** The wall-clock fields `timeZone` showed at `epochMs`. */
export function wallClockAt(epochMs: number, timeZone: string): WallClockParts {
  const shifted = new Date(epochMs + zoneOffsetMs(epochMs, timeZone));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** The weekday `timeZone` showed at `epochMs`. 0 = Sunday. */
export function weekdayAt(epochMs: number, timeZone: string): number {
  return new Date(epochMs + zoneOffsetMs(epochMs, timeZone)).getUTCDay();
}

function partsEqual(left: WallClockParts, right: WallClockParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

/**
 * The first instant at or after `lowMs` where the zone's offset differs from
 * the offset at `lowMs`. Used to find where a DST gap ends.
 *
 * Bisection rather than a scan: the bracket is at most a day wide and
 * transitions land on minute boundaries, so ~27 probes settle it exactly.
 */
function findTransitionMs(lowMs: number, highMs: number, timeZone: string): number {
  const startOffset = zoneOffsetMs(lowMs, timeZone);
  let low = lowMs;
  let high = highMs;
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (zoneOffsetMs(mid, timeZone) === startOffset) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return high;
}

/**
 * Resolve a wall-clock time in a zone to the instant or instants it denotes.
 *
 * The core DST primitive. Most local times denote one instant; on the two
 * transition dates a local time may denote none (`gap`) or two (`fold`). See
 * `LocalTimeResolution` for why each is a real case rather than trivia.
 *
 * The method: form the naive UTC reading of the fields, then correct it by the
 * offsets in force a day either side. Those two offsets bracket any single
 * transition within the day, so the two corrections give every candidate that
 * could exist. Each candidate is then *verified* by formatting it back — a
 * candidate is real only if the zone actually shows the requested fields at it.
 * Zero survivors is a gap, two is a fold.
 *
 * Verifying rather than trusting the correction is the point. The usual
 * one-pass "guess, read offset, re-guess" produces a plausible instant in both
 * anomalous cases — for a folded time it silently returns the earlier of two
 * answers, and for a skipped time it returns an instant whose local clock reads
 * something else entirely. Neither raises anything for a caller to notice.
 */
export function resolveLocalTime(parts: WallClockParts, timeZone: string): LocalTimeResolution {
  const naiveMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const offsetBefore = zoneOffsetMs(naiveMs - MS_PER_DAY, timeZone);
  const offsetAfter = zoneOffsetMs(naiveMs + MS_PER_DAY, timeZone);

  const candidates = Array.from(new Set([naiveMs - offsetBefore, naiveMs - offsetAfter]))
    .sort((left, right) => left - right);
  const valid = candidates.filter((candidate) => partsEqual(wallClockAt(candidate, timeZone), parts));

  if (valid.length === 1) {
    return { kind: 'exact', instant: toInstant(valid[0]) };
  }
  if (valid.length >= 2) {
    return {
      kind: 'fold',
      firstInstant: toInstant(valid[0]),
      secondInstant: toInstant(valid[valid.length - 1]),
    };
  }
  // A gap: the local clock skips these fields. The window resumes at the
  // transition itself, which lies between the two rejected candidates.
  const low = Math.min(candidates[0], candidates[candidates.length - 1]);
  const high = Math.max(candidates[0], candidates[candidates.length - 1]);
  return { kind: 'gap', resumesAt: toInstant(findTransitionMs(low, high, timeZone)) };
}

/**
 * Collapse a `LocalTimeResolution` to one instant using a fold policy.
 *
 * Returns null for a gap, because there is no instant to return and inventing
 * one is exactly the failure this module exists to prevent. Callers that need
 * a window to resume after a gap read `resumesAt` themselves — the decision of
 * whether a skipped start shortens a window or invalidates it belongs to the
 * track that owns windows, not to this primitive.
 */
export function instantFromResolution(
  resolution: LocalTimeResolution,
  foldPolicy: 'earliest' | 'latest',
): Instant | null {
  if (resolution.kind === 'exact') return resolution.instant;
  if (resolution.kind === 'gap') return null;
  return foldPolicy === 'earliest' ? resolution.firstInstant : resolution.secondInstant;
}

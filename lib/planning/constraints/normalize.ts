/**
 * Materialising wall-clock working windows into absolute intervals.
 *
 * A `WorkingWindow` is a rule about a clock face — "Tuesdays, 09:00 until
 * 17:00, in Asia/Jerusalem". A scheduler cannot place anything against a rule;
 * it needs instants. Turning one into the other is this module's whole job, and
 * it is *arithmetic* rather than judgement, which is why the design lets #30 and
 * #31 import it: a second copy of this conversion is the Sprint 06 gap, not a
 * Sprint 06 check.
 *
 * Four decisions here are structural, each because the obvious alternative
 * fails without saying so.
 *
 *  1. **A window that starts in a DST gap is shortened, not dropped and not
 *     invented.** On the spring-forward date the local clock jumps 02:00 → 03:00
 *     and a window stated to begin at 02:30 begins at no instant at all. The
 *     honest reading is that the user is available from the moment the clock
 *     resumes, so the occurrence starts at `resumesAt` and is that much shorter.
 *     Dropping it would remove availability the user has; keeping the naive UTC
 *     arithmetic would hand the scheduler a slot that did not occur, and every
 *     downstream overlap check would agree it was free.
 *
 *  2. **A fold is resolved by `PlanningConfig.foldPolicy`, at both ends.** On
 *     the fall-back date 01:30 happens twice, an hour apart. The policy is
 *     stated in the config so a plan and a replay of that plan resolve it the
 *     same way. It is applied to the *end* of a window as well as the start,
 *     which means `earliest` lengthens a window that starts in a fold and
 *     shortens one that ends in a fold. Picking per-end so as to always maximise
 *     the window was the tempting alternative and was rejected: the policy would
 *     then mean two different things depending on which end asked, and no test
 *     of one end would constrain the other.
 *
 *  3. **Clipping only ever removes time.** The horizon is half-open and an
 *     occurrence is intersected with it; an occurrence abutting `endsAt` shares
 *     one instant with the horizon and contributes nothing, so it is dropped
 *     rather than kept as a zero-length interval — which would satisfy every
 *     overlap assertion while representing no time (see `TimeInterval`).
 *
 *  4. **A malformed window is reported by index and skipped, never repaired.**
 *     `endMinute <= startMinute` does not wrap to the next day: the contract
 *     says overnight availability is two windows, one per weekday, because a
 *     wrapping window makes "which weekday is this?" ambiguous exactly when a
 *     transition lands inside it. Materialising a wrap would invent availability
 *     on a day the user never named. The indices travel out so the validator can
 *     report `INVALID_INTERVAL` once, in one place, rather than each caller
 *     deciding separately what a bad window means.
 *
 * Nothing here reads an ambient clock. Every instant is derived from the
 * horizon and the windows passed in, per `PLANNING_PERSISTENCE_POLICY`.
 */

import type {
  FixedEvent,
  PlanningConfig,
  PlanningHorizon,
  TimeInterval,
  WorkingWindow,
} from '../../../src/contracts/v1/planningContracts';
import { MINUTES_PER_DAY } from '../../../src/contracts/v1/planningContracts';
import {
  instantFromResolution,
  intersectIntervals,
  isPositiveInterval,
  resolveLocalTime,
  subtractIntervals,
  toEpochMs,
  toInstant,
  wallClockAt,
  weekdayAt,
  zoneOffsetMs,
  type WallClockParts,
} from '../shared/time';

const MS_PER_DAY = 86_400_000;

/** How a window's local boundary resolved on the date it landed on. */
export type BoundaryResolutionKind = 'exact' | 'gap' | 'fold';

/**
 * One occurrence of a recurring window, as absolute time.
 *
 * `windowIndex` is the position of the source window in the input array. It is
 * carried because a `PlanningReason.detail` may not repeat user-chosen text and
 * a `windowId` is user-chosen — so findings about a window name it by position,
 * the way the decomposition validator names a step index.
 */
export interface MaterializedWindow {
  readonly windowId: string;
  readonly windowIndex: number;
  /** Absolute, half-open, already intersected with the horizon. */
  readonly interval: TimeInterval;
  /** The local date in the window's own zone, `YYYY-MM-DD`. */
  readonly localDate: string;
  /** How the window's local *start* resolved on that date. */
  readonly startKind: BoundaryResolutionKind;
  /** How the window's local *end* resolved on that date. */
  readonly endKind: BoundaryResolutionKind;
  /** True when the horizon removed time from either end of this occurrence. */
  readonly clippedToHorizon: boolean;
}

/**
 * A local boundary that denoted no instant, or two.
 *
 * Recorded for the *end* of a window as well as the start, even though the
 * contract's `NONEXISTENT_LOCAL_TIME` and `AMBIGUOUS_LOCAL_TIME` are defined
 * over starts. An end landing in a fold silently changes the length of the day,
 * and a normalizer that noticed it and said nothing would leave the one caller
 * who cares — a report of why capacity moved — with nowhere to look. The
 * validator filters to `boundary === 'start'` so what it emits stays exactly
 * what the contract describes.
 */
export interface WindowAnomaly {
  readonly windowId: string;
  readonly windowIndex: number;
  readonly localDate: string;
  readonly boundary: 'start' | 'end';
  readonly kind: 'gap' | 'fold';
}

export interface NormalizedWindows {
  /** Ordered by start instant, then by `windowId`. May overlap each other. */
  readonly windows: readonly MaterializedWindow[];
  readonly anomalies: readonly WindowAnomaly[];
  /** Positions in the input array that could not be materialised at all. */
  readonly malformedWindowIndices: readonly number[];
}

/* ── Zones and calendar dates ────────────────────────────────────── */

/**
 * Whether the runtime knows this IANA zone.
 *
 * `Intl.DateTimeFormat` throws a `RangeError` on an unknown zone, and the
 * shared offset reader does not catch it. Probing here rather than swallowing
 * the throw downstream is deliberate: a swallowed failure would have to fall
 * back to *some* offset, and the only available fallback is UTC — which would
 * place a Kolkata user's morning five and a half hours from where they said it
 * was, with nothing downstream able to tell that had happened.
 */
function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** A calendar date, independent of any zone. */
interface CalendarDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function calendarDateFromUtcMs(utcMs: number): CalendarDate {
  const date = new Date(utcMs);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function calendarDateToUtcMs(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  return calendarDateFromUtcMs(calendarDateToUtcMs(date) + days * MS_PER_DAY);
}

function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

/**
 * The weekday a calendar date falls on.
 *
 * Asked of the shared primitive in UTC rather than computed here, because a
 * calendar date's weekday is a property of the calendar and not of any zone —
 * `2026-03-08` is a Sunday in Kolkata and in New York alike. Routing it through
 * `weekdayAt` keeps one implementation of "what day is this" in the sprint
 * rather than two that agree until one of them is edited.
 */
function weekdayOfCalendarDate(date: CalendarDate): number {
  return weekdayAt(calendarDateToUtcMs(date), 'UTC');
}

function partsAt(date: CalendarDate, minuteOfDay: number): WallClockParts {
  return {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
  };
}

/* ── Materialisation ─────────────────────────────────────────────── */

function isWholeMinuteInDay(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= MINUTES_PER_DAY;
}

/**
 * Whether a window can be materialised at all.
 *
 * Everything checked here makes the window meaningless rather than merely
 * unusual, so there is nothing to place and nothing to clip. The window's index
 * is returned to the caller instead, and the validator turns it into exactly one
 * `INVALID_INTERVAL`.
 */
function isMaterialisable(window: WorkingWindow): boolean {
  if (!Number.isInteger(window.weekday) || window.weekday < 0 || window.weekday > 6) return false;
  if (!isWholeMinuteInDay(window.startMinute) || !isWholeMinuteInDay(window.endMinute)) return false;
  // A window occupying the whole day starts at minute 0; `startMinute === 1440`
  // would leave no room for a positive window and is caught by the next line.
  if (window.endMinute <= window.startMinute) return false;
  return typeof window.timezone === 'string' && isKnownTimeZone(window.timezone);
}

interface ResolvedBoundary {
  /**
   * Null when no instant can be chosen at all.
   *
   * That is one case and only one: a boundary landing in a fold under a
   * `foldPolicy` this runtime does not recognise. `FoldPolicy` makes it
   * unreachable through the type, and every typed caller therefore never sees a
   * null here — but #31's oracle sits on an untyped boundary by design, and a
   * config loaded from data can carry anything.
   */
  readonly epochMs: number | null;
  readonly kind: BoundaryResolutionKind;
}

/**
 * The instant a local boundary of a window denotes, and how it got there.
 *
 * A gap resolves to `resumesAt` at *both* ends, and that is what makes the two
 * cases agree. At the start it means "available from the moment the clock
 * resumes"; at the end it means "the window closed when the clock jumped".
 * A window lying entirely inside a gap therefore collapses to zero length and is
 * dropped by the positivity check — which is the right answer, since the local
 * hour it named never happened.
 */
function resolveBoundary(
  date: CalendarDate,
  minuteOfDay: number,
  timezone: string,
  foldPolicy: PlanningConfig['foldPolicy'],
): ResolvedBoundary {
  // Minute 1440 is midnight *ending* this local day, which is minute 0 of the
  // next one. Reading it as minute 0 of the same day is the bug the contract's
  // 0..1440 domain exists to prevent: it produces a window ending before it
  // began, and `INVALID_INTERVAL` would then be reported about a window the
  // user stated perfectly correctly.
  const onDate = minuteOfDay === MINUTES_PER_DAY ? addCalendarDays(date, 1) : date;
  const minute = minuteOfDay === MINUTES_PER_DAY ? 0 : minuteOfDay;

  const resolution = resolveLocalTime(partsAt(onDate, minute), timezone);
  if (resolution.kind === 'gap') {
    return { epochMs: toEpochMs(resolution.resumesAt), kind: 'gap' };
  }
  const instant = instantFromResolution(resolution, foldPolicy);
  // Null reaches here only for a fold the configured policy does not resolve;
  // the gap case returned above. It is passed on rather than cast away, and the
  // cast is what this replaces: `toEpochMs(instant as string)` turned an
  // unresolvable fold into `TypeError: not a parseable ISO-8601 instant: null`,
  // thrown from three frames inside a function whose callers — a scenario
  // corpus loaded from data, an oracle whose whole job is to *return* what is
  // wrong with an input — must get a finding rather than an exception. Which
  // finding is theirs to decide; this module records `kind: 'fold'` on the
  // boundary and contributes no interval, which is the honest answer to "when
  // is this window?" when nothing chose between the two candidates.
  return { epochMs: instant === null ? null : toEpochMs(instant), kind: resolution.kind };
}

/**
 * The widest span of instants a local boundary could plausibly denote on its
 * date, ignoring the transition entirely.
 *
 * This is the *nominal* reading: where the boundary would have sat if the
 * offset had not moved that day. It exists to answer one question — would this
 * occurrence have met the horizon at all? — and it has to be computable for a
 * local time that denotes *no* instant, which is exactly when `resolveBoundary`
 * has no answer to give.
 *
 * Bracketed rather than pinned to one offset, using the offsets a day either
 * side, the same two `resolveLocalTime` uses. Picking a single anchor offset
 * would need an anchor instant, and the obvious candidate — local midnight of
 * the date — is itself a fold in America/Havana and a gap in other zones, so the
 * anchor would need the very machinery it is meant to stand in for. The bracket
 * needs no anchor and errs outward, which is the safe direction: it can only
 * make this module report an anomaly it might have filtered, never hide one.
 */
function nominalBracket(
  date: CalendarDate,
  minuteOfDay: number,
  timeZone: string,
): { readonly minMs: number; readonly maxMs: number } {
  const onDate = minuteOfDay === MINUTES_PER_DAY ? addCalendarDays(date, 1) : date;
  const minute = minuteOfDay === MINUTES_PER_DAY ? 0 : minuteOfDay;
  const naiveMs = Date.UTC(
    onDate.year,
    onDate.month - 1,
    onDate.day,
    Math.floor(minute / 60),
    minute % 60,
  );
  const before = naiveMs - zoneOffsetMs(naiveMs - MS_PER_DAY, timeZone);
  const after = naiveMs - zoneOffsetMs(naiveMs + MS_PER_DAY, timeZone);
  return { minMs: Math.min(before, after), maxMs: Math.max(before, after) };
}

/**
 * Materialise recurring wall-clock windows into absolute intervals clipped to
 * the horizon.
 *
 * Pure: the same windows, horizon and config always produce the same result,
 * which is what lets a plan be replayed and compared. Cost is linear in the
 * number of matching weekdays in the horizon — the scan steps seven calendar
 * days at a time rather than filtering every date — so a long horizon is slow
 * in proportion and never quadratic.
 */
export function normalizeWorkingWindows(
  windows: readonly WorkingWindow[],
  horizon: PlanningHorizon,
  config: PlanningConfig,
): NormalizedWindows {
  const malformedWindowIndices: number[] = [];
  const materialized: MaterializedWindow[] = [];
  const anomalies: WindowAnomaly[] = [];

  const horizonStartMs = toEpochMs(horizon.startsAt);
  const horizonEndMs = toEpochMs(horizon.endsAt);

  for (let index = 0; index < windows.length; index += 1) {
    if (!isMaterialisable(windows[index])) malformedWindowIndices.push(index);
  }

  // A horizon that is not a positive interval has no dates in it. Reporting it
  // is `INVALID_INTERVAL`'s job, done once by the validator; a normalizer that
  // also threw would give two answers to "is this input usable" depending on
  // which caller asked first.
  if (horizonEndMs <= horizonStartMs) {
    return { windows: [], anomalies: [], malformedWindowIndices };
  }

  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (!isMaterialisable(window)) continue;

    // The local dates the horizon touches, in this window's own zone. Read from
    // the zone rather than from UTC because a horizon starting at 23:30Z is
    // already the next local day in Kolkata, and a scan anchored on the UTC date
    // would miss that day's window entirely.
    const firstLocal = wallClockAt(horizonStartMs, window.timezone);
    const lastLocal = wallClockAt(horizonEndMs, window.timezone);
    const lastDateMs = calendarDateToUtcMs({ year: lastLocal.year, month: lastLocal.month, day: lastLocal.day });

    // Backed up one calendar day, because an occurrence can outlive its own
    // local date. A window ending at `endMinute: 1440` ends at midnight of the
    // *next* local day, and in a zone whose midnight is the folded hour —
    // America/Havana ends DST at 01:00 local, so 00:00 happens twice — a
    // `latest` fold policy carries that end an hour further still. A horizon
    // opening inside such an occurrence has a local date one day after the
    // occurrence's, so scanning only from the horizon's own local date dropped
    // it and reported no availability at all.
    //
    // One day is enough and not arbitrary: an occurrence for local date D ends
    // no later than local midnight of D+1 plus a fold hour, so one whose end is
    // still ahead of the horizon start cannot be older than the local date
    // before it. Reaching back further would cost probes and find nothing. The
    // extra day admits occurrences that finished before the horizon; the clip
    // below discards them, which is exactly the division of labour that keeps
    // "never extend past the horizon" true in one place.
    const firstDate = addCalendarDays(
      { year: firstLocal.year, month: firstLocal.month, day: firstLocal.day },
      -1,
    );

    // Step to the first matching weekday, then by whole weeks. Weekday
    // arithmetic is done on the calendar, where a week is always seven days,
    // rather than on instants, where the two transition weeks are not 168 hours.
    const offsetToWeekday = (7 + window.weekday - weekdayOfCalendarDate(firstDate)) % 7;
    let date = addCalendarDays(firstDate, offsetToWeekday);

    while (calendarDateToUtcMs(date) <= lastDateMs) {
      const start = resolveBoundary(date, window.startMinute, window.timezone, config.foldPolicy);
      const end = resolveBoundary(date, window.endMinute, window.timezone, config.foldPolicy);
      const localDate = formatCalendarDate(date);

      // An anomaly is reported only when the occurrence carrying it would have
      // met the horizon had the offset not moved — the *nominal* extent, not the
      // resolved one.
      //
      // The cross-track test found this: a spring gap on Sunday the 8th was
      // reported against a horizon opening on the 9th, sending the user to fix a
      // window with no bearing on anything being planned. #31's oracle stayed
      // quiet and was right. Filtering here rather than in the validator is what
      // keeps one answer to the question: the validator reports what it is
      // handed, so it follows automatically, and so does every other consumer.
      //
      // The nominal extent is what separates the two cases that look identical
      // from the outside, since neither leaves a materialised window behind:
      //
      //   - swallowed by the gap, inside the horizon — nominal extent is a real
      //     stretch of local time the plan covers. The user asked for an hour and
      //     lost it, and must be told. Pinned at oracleFeasibility.test.ts:822.
      //   - clipped away by the horizon — nominal extent lies outside the plan
      //     entirely. Silence.
      //
      // "Did anything survive the clip?" cannot tell them apart; both survive
      // nothing. Note this also covers the extra day the weekday scan reaches
      // back over, whose occurrences are usually outside the horizon by
      // construction.
      const nominalStartMs = nominalBracket(date, window.startMinute, window.timezone).minMs;
      const nominalEndMs = nominalBracket(date, window.endMinute, window.timezone).maxMs;
      const nominallyInHorizon = nominalStartMs < horizonEndMs && nominalEndMs > horizonStartMs;

      if (nominallyInHorizon) {
        for (const [boundary, resolved] of [['start', start], ['end', end]] as const) {
          if (resolved.kind !== 'exact') {
            anomalies.push({
              windowId: window.windowId,
              windowIndex: index,
              localDate,
              boundary,
              kind: resolved.kind,
            });
          }
        }
      }

      // An unresolved boundary yields no occurrence at either end. Applied to
      // the *end* as well as the start for the reason the fold policy itself is:
      // a rule that meant one thing at the start and another at the end would be
      // constrained by no test of either.
      const occurrence: TimeInterval | null = start.epochMs === null || end.epochMs === null
        ? null
        : { startsAt: toInstant(start.epochMs), endsAt: toInstant(end.epochMs) };
      // A window whose local hours were entirely skipped by a forward
      // transition collapses to nothing. It is not an error — the user named an
      // hour that did not happen that week — so it is simply absent, while the
      // anomaly above records that it was asked for.
      if (occurrence !== null && isPositiveInterval(occurrence)) {
        const clipped = intersectIntervals(occurrence, { startsAt: horizon.startsAt, endsAt: horizon.endsAt });
        if (clipped !== null) {
          materialized.push({
            windowId: window.windowId,
            windowIndex: index,
            interval: clipped,
            localDate,
            startKind: start.kind,
            endKind: end.kind,
            clippedToHorizon:
              clipped.startsAt !== occurrence.startsAt || clipped.endsAt !== occurrence.endsAt,
          });
        }
      }

      date = addCalendarDays(date, 7);
    }
  }

  // Sorted by start instant then `windowId`, so the result never depends on the
  // order the caller happened to list its windows in. Two callers holding the
  // same availability written down differently must get the same normalisation,
  // or a plan's `inputDigest` stops meaning what #30 needs it to mean.
  materialized.sort(
    (left, right) =>
      toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt)
      || (left.windowId < right.windowId ? -1 : left.windowId > right.windowId ? 1 : 0)
      || left.windowIndex - right.windowIndex,
  );
  anomalies.sort(
    (left, right) =>
      (left.localDate < right.localDate ? -1 : left.localDate > right.localDate ? 1 : 0)
      || left.windowIndex - right.windowIndex
      || (left.boundary === right.boundary ? 0 : left.boundary === 'start' ? -1 : 1),
  );

  return { windows: materialized, anomalies, malformedWindowIndices };
}

/* ── Free time ───────────────────────────────────────────────────── */

/**
 * Collapse overlapping and abutting intervals into the disjoint stretches they
 * jointly cover, ordered.
 *
 * Abutting intervals are merged even though they do not *overlap*: `[09,10)`
 * and `[10,11)` are one continuous stretch of available time, and leaving them
 * apart would make a ninety-minute task unplaceable inside two free hours
 * without anything reporting why. This is the one place in the sprint where
 * touching intervals are joined rather than kept distinct, and it is not a
 * different reading of the half-open rule — `intervalsOverlap` still says these
 * two do not overlap. Union and overlap are different questions.
 */
export function mergeIntervals(intervals: readonly TimeInterval[]): TimeInterval[] {
  const ordered = intervals
    .filter(isPositiveInterval)
    .slice()
    .sort((left, right) => toEpochMs(left.startsAt) - toEpochMs(right.startsAt));

  const merged: { startMs: number; endMs: number }[] = [];
  for (const interval of ordered) {
    const startMs = toEpochMs(interval.startsAt);
    const endMs = toEpochMs(interval.endsAt);
    const last = merged[merged.length - 1];
    if (last && startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, endMs);
      continue;
    }
    merged.push({ startMs, endMs });
  }
  return merged.map((span) => ({ startsAt: toInstant(span.startMs), endsAt: toInstant(span.endMs) }));
}

/**
 * The stretches of time inside the materialised windows that nothing already
 * occupies: availability minus the blocking fixed events.
 *
 * The windows are unioned *before* the events are subtracted. Two windows
 * describing the same stretch of availability are one stretch, and a free-run
 * list that returned it twice would let a capacity count claim hours the user
 * does not have — while every interval in it remained individually correct, so
 * no per-interval assertion would notice.
 *
 * Only `blocking` events are subtracted. A non-blocking event is one the user
 * said work may happen inside; removing it would quietly shrink the day on the
 * strength of a flag that says the opposite.
 */
export function freeRunsWithin(
  windows: readonly MaterializedWindow[],
  fixedEvents: readonly FixedEvent[],
): TimeInterval[] {
  const cuts = fixedEvents
    .filter((event) => event.blocking)
    .map((event) => event.interval)
    // A degenerate event occupies no time. Subtracting it would split a window
    // in two at an instant nothing actually holds; `subtractIntervals` drops
    // zero-length remnants but not zero-length *cuts*, so it is filtered here.
    .filter(isPositiveInterval);

  return mergeIntervals(windows.map((materialized) => materialized.interval))
    .flatMap((available) => subtractIntervals(available, cuts));
}

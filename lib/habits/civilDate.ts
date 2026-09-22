/**
 * Civil-date arithmetic: `YYYY-MM-DD` in, `YYYY-MM-DD` out, no zone anywhere.
 *
 * ── Why this is not in `lib/planning/shared/time.ts` ─────────────
 *
 * That module exists so DST arithmetic lives in one place. This module exists
 * so that a habit never does DST arithmetic at all.
 *
 * The distinction is the whole of #520's "DST and timezone changes do not
 * duplicate occurrences". A habit's demand is a *date* — "a gym session on
 * Wednesday" — and the run of dates 2026-03-06, 03-07, 03-08, 03-09 is the
 * same run whether or not the zone lost an hour inside it. Step through a week
 * by adding 86,400,000 milliseconds to a local timestamp instead and the
 * spring-forward day arrives at 23:00 the previous evening: one date comes out
 * twice, one never comes out at all, and both are duplicate or missing gym
 * sessions with ids to match.
 *
 * So everything here counts days, and it reaches `Date` only through
 * `Date.UTC` and `getUTC*`, which is calendar arithmetic with no offset in it
 * — UTC has never had a transition and never will. Turning a demand date into
 * an actual interval in the user's zone is the adapter's job, and the adapter
 * has `resolveLocalTime` for it.
 *
 * Nothing here reads an ambient clock, for the same reason the planner does
 * not: a function that could call `Date.now()` would materialize a different
 * set of occurrences on every run and no determinism test could catch it.
 */

import { HABIT_LOCAL_DATE_PATTERN, HabitValidationError } from '../../src/contracts/v1/habitContracts';

const MS_PER_DAY = 86_400_000;

/** Days since 1970-01-01, which was a Thursday. */
export type CivilDays = number;

/**
 * Parse a `YYYY-MM-DD` to a day number.
 *
 * Rejects rather than rolls over. `Date.UTC(2026, 1, 30)` happily yields
 * 2026-03-02, so a pattern match alone would accept 2026-02-30 and silently
 * materialize an occurrence two days after the one the caller asked for. The
 * round-trip below is what closes that: a date that does not format back to
 * itself did not exist.
 */
export function toCivilDays(localDate: string): CivilDays {
  if (typeof localDate !== 'string' || !HABIT_LOCAL_DATE_PATTERN.test(localDate)) {
    throw new HabitValidationError(`not a YYYY-MM-DD local date: ${JSON.stringify(localDate)}`);
  }
  const year = Number(localDate.slice(0, 4));
  const month = Number(localDate.slice(5, 7));
  const day = Number(localDate.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const days = Math.floor(ms / MS_PER_DAY);
  if (fromCivilDays(days) !== localDate) {
    throw new HabitValidationError(`no such date: ${localDate}`);
  }
  return days;
}

/** The `YYYY-MM-DD` a day number denotes. */
export function fromCivilDays(days: CivilDays): string {
  if (!Number.isInteger(days)) {
    throw new HabitValidationError(`not a whole number of days: ${String(days)}`);
  }
  const date = new Date(days * MS_PER_DAY);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 0 = Sunday, matching `HabitCadence`'s `weekdays` and `Date#getUTCDay`. */
export function weekdayOfCivilDays(days: CivilDays): number {
  // 1970-01-01 was a Thursday, so day 0 is weekday 4.
  return ((days + 4) % 7 + 7) % 7;
}

export function weekdayOfLocalDate(localDate: string): number {
  return weekdayOfCivilDays(toCivilDays(localDate));
}

/**
 * The Monday on or before `days`.
 *
 * `HABIT_PERIOD_START_WEEKDAY` says Monday and this is the only place that
 * acts on it, so materialization and recovery cannot disagree about which week
 * a Sunday belongs to — the disagreement that would let a Sunday skip recover
 * into a week that is already full.
 */
export function periodStartOf(days: CivilDays): CivilDays {
  // Day 4 (1970-01-05) was a Monday, so `(days + 3) % 7` is 0 on Mondays.
  return days - (((days + 3) % 7) + 7) % 7;
}

/** A stable index for the week containing `days`; equal iff same period. */
export function periodIndexOf(days: CivilDays): number {
  return Math.floor((days + 3) / 7);
}

export function addDays(localDate: string, days: number): string {
  return fromCivilDays(toCivilDays(localDate) + days);
}

/** Inclusive count: the same date on both ends is one day. */
export function daysBetweenInclusive(fromLocalDate: string, toLocalDate: string): number {
  return toCivilDays(toLocalDate) - toCivilDays(fromLocalDate) + 1;
}

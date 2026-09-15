/**
 * When this account wants its day planned, and when that next falls (UC-3.10a, #194).
 *
 * ── Why the next delivery instant is stored rather than searched for ──
 *
 * "Every morning" is a per-user wall-clock promise; a cron fires at one
 * instant. The two are reconciled either by a sweep that asks every enabled
 * account "is it your morning?" once a minute, or by writing down, in advance,
 * the instant each account's next morning falls on. This module does the
 * second.
 *
 * The difference is not micro-optimisation. A sweep that filters in code reads
 * every enabled account on every one of the 1,440 ticks in a day, so its cost
 * is the size of the user base times 1,440 — and it grows with the product.
 * `planSettings.nextRunAt` turns the same question into a range read that
 * returns only the accounts actually due, which on a normal minute is none.
 *
 * It is also what makes the delivery *idempotent*: advancing `nextRunAt` is a
 * single compare-and-set on one field, so two ticks racing over the same
 * account cannot both proceed. See `dailyPlanService.claimDueDelivery`.
 *
 * ── The field is absent, never null, when delivery is off ────────
 *
 * Firestore does not return a document in a range query when the queried field
 * is missing, and *does* return one when the field is null (null sorts below
 * every string). A disabled account therefore has no `nextRunAt` key at all —
 * writing `null` would put every account that ever switched the feature off
 * back into the result set of every sweep, forever.
 */
import {
  instantFromResolution,
  resolveLocalTime,
  wallClockAt,
  toEpochMs,
} from '../../planning/shared/time';
import type { Instant } from '../../../src/contracts/v1/planningContracts';
import { isValidTimezone } from '../../../src/contracts/v1/routineContracts';

/** Until the user opts in through UC-3.10b (#195), nothing is built for them. */
export const DEFAULT_PLAN_ENABLED = false;
export const DEFAULT_DELIVERY_LOCAL_TIME = '07:30';
/**
 * How many plan documents one account may have for one day.
 *
 * The morning build is generation 1, so this is **one more** than the number of
 * rebuilds a user gets. The cap is compared against the stored `generation`
 * rather than a counter of its own, which is what keeps it honest — and is also
 * how the 429 came to say "5 times" about a limit that allowed four. The two
 * numbers are now one number and one subtraction, so they cannot drift again.
 */
export const MAX_PLAN_GENERATIONS_PER_DAY = 5;

/** What the user is actually offered, and what the 429 body must say. */
export const MAX_PLAN_REBUILDS_PER_DAY = MAX_PLAN_GENERATIONS_PER_DAY - 1;

const HHMM = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

export interface PlanSettings {
  enabled: boolean;
  /** `HH:mm` on the user's own clock face. */
  deliveryLocalTime: string;
  /** IANA zone the delivery time is read in. */
  timezone: string;
  /**
   * The instant the next build is due, absent when `enabled` is false.
   *
   * Optional rather than nullable on purpose — see the header.
   */
  nextRunAt?: Instant;
  /** The local date the last claim was made for. Diagnostic, never a gate. */
  lastDeliveredDate?: string;
}

/** The user document, as this module reads and writes it. */
export interface PlanSettingsBearingUser {
  planSettings?: PlanSettings;
  timezone?: string | null;
  locale?: string | null;
}

export class PlanSettingsValidationError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = 'PlanSettingsValidationError';
  }
}

/** `HH:mm`, split into numbers. Throws on anything else. */
export function parseDeliveryLocalTime(value: unknown): { hour: number; minute: number } {
  if (typeof value !== 'string') {
    throw new PlanSettingsValidationError('deliveryLocalTime must be a string', 'invalid_delivery_time');
  }
  const match = HHMM.exec(value.trim());
  if (!match) {
    throw new PlanSettingsValidationError(
      `deliveryLocalTime must be HH:mm between 00:00 and 23:59, received ${JSON.stringify(value)}`,
      'invalid_delivery_time',
    );
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The stored settings, or the defaults for an account that has never chosen.
 *
 * A stored record that is not readable — written by a future schema, or edited
 * by hand — reads as the defaults, which means delivery is *off*. That is the
 * safe direction: the failure mode of guessing is a push nobody asked for.
 *
 * ── The account's timezone wins over the stored one ──────────────
 *
 * `planSettings.timezone` was written at the last `savePlanSettings`, and
 * nothing recomputed it afterwards. A user who moved Tel Aviv → New York
 * therefore kept being delivered at 07:30 *Israel* time — 00:30 where they now
 * are — until they toggled the setting off and on again, because every read of
 * the settings read the snapshot rather than the account.
 *
 * So `accountTimezone` — `users/{uid}.timezone`, the field every other dated
 * read in this product uses — is authoritative whenever it is a zone `Intl`
 * knows, and the stored value survives only when it is not. The snapshot is
 * kept in the document because it is what the last delivery was computed under,
 * and comparing the two is how `claimDueDelivery` notices the move; it is no
 * longer what anything reads.
 */
export function planSettingsOf(user: PlanSettingsBearingUser | null, accountTimezone: string): PlanSettings {
  const stored = user?.planSettings;
  if (
    !stored
    || typeof stored.enabled !== 'boolean'
    || !HHMM.test(String(stored.deliveryLocalTime))
    || !isValidTimezone(stored.timezone)
  ) {
    return {
      enabled: DEFAULT_PLAN_ENABLED,
      deliveryLocalTime: DEFAULT_DELIVERY_LOCAL_TIME,
      timezone: accountTimezone,
    };
  }
  if (isValidTimezone(accountTimezone) && accountTimezone !== stored.timezone) {
    return { ...stored, timezone: accountTimezone };
  }
  return stored;
}

/**
 * The first instant strictly after `after` at which the local clock in
 * `timezone` reads `deliveryLocalTime`.
 *
 * Both DST anomalies are answered rather than approximated. On a spring-forward
 * date the chosen local time may not exist at all; the delivery then happens at
 * the instant the clock jumps to, which is the earliest moment the user's
 * morning can be said to have reached that time. On a fall-back date it exists
 * twice, and the earlier of the two is taken — consistent with
 * `FoldPolicy.earliest`, which is the policy the plan itself is built under, so
 * a plan is never delivered under one reading of the day and built under
 * another.
 *
 * Four candidate dates are tried, not one: `after` may sit past today's
 * delivery time, and a gap can push a resolution forward past midnight.
 */
export function nextDeliveryAt(after: Instant, settings: Pick<PlanSettings, 'deliveryLocalTime' | 'timezone'>): Instant {
  const { hour, minute } = parseDeliveryLocalTime(settings.deliveryLocalTime);
  const timezone = settings.timezone;
  const afterMs = toEpochMs(after);
  const local = wallClockAt(afterMs, timezone);

  for (let offset = 0; offset <= 3; offset += 1) {
    const day = new Date(Date.UTC(local.year, local.month - 1, local.day + offset));
    const resolution = resolveLocalTime(
      { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate(), hour, minute },
      timezone,
    );
    // A gap has no instant to choose, so the window resumes at the transition.
    const candidate = resolution.kind === 'gap'
      ? resolution.resumesAt
      : instantFromResolution(resolution, 'earliest');
    if (candidate && toEpochMs(candidate) > afterMs) return candidate;
  }
  // Unreachable for any zone `Intl` knows: some local time in the next three
  // days is always after `after`. Thrown rather than defaulted, because a
  // silently wrong delivery instant is a plan that arrives at the wrong hour
  // every day and never announces itself.
  throw new PlanSettingsValidationError(
    `no delivery instant for ${settings.deliveryLocalTime} in ${timezone} within three days of ${after}`,
    'unresolvable_delivery_time',
  );
}

/** The local calendar date, `YYYY-MM-DD`, that an instant falls on in a zone. */
export function localDateOf(instant: Instant, timezone: string): string {
  const parts = wallClockAt(toEpochMs(instant), timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isPlanDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE_KEY.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const round = new Date(Date.UTC(year, month - 1, day));
  return round.getUTCFullYear() === year && round.getUTCMonth() + 1 === month && round.getUTCDate() === day;
}

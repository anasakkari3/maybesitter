/**
 * A weekly fixed block — «ثابت أسبوعي» (owner request, 2026-09-29).
 *
 * "Routine things like work or an internship from 10 until 4 every Saturday:
 * reserve it and schedule it automatically every week until I change it."
 *
 * ── What it is, and what it is not ───────────────────────────────
 *
 * A standing claim on the same hours every week: *time somebody is already
 * spoken for*, like a lecture from a syllabus (#191) — not a commitment to
 * finish, and not a habit (#520), which is demand the planner must find room
 * for. It reaches the planner as busy blocks under the source `weekly-{id}`,
 * so the day plan, the week plan and the replan tick honour it without
 * knowing it exists.
 *
 * ── Confirmation is structural ───────────────────────────────────
 *
 * `parseWeeklyBlockInput` refuses a body with no `confirmation`. Nothing —
 * not a capture's recurrence hint, not a model — becomes a weekly block until
 * the person confirmed it, and the moment they did is stored as
 * `confirmedAt`. A patch cannot restate it.
 *
 * ── Content ──────────────────────────────────────────────────────
 *
 * `title` is the person's own words and is owner-only data: it lives on the
 * block document in their tree (deleted and exported with the account), is
 * never logged, and never enters telemetry. Everything else here — weekdays,
 * clock times, a zone, a status — is content-free. The busy blocks the block
 * materializes carry no title at all (the busy-block contract has none); the
 * phone's read model joins the title back from this document.
 *
 * ── v1 limits ────────────────────────────────────────────────────
 *
 * Same-day only: a start at or after its end is refused as
 * `overnight_not_supported` rather than wrapped into the next day.
 */
import { isValidTimezone } from './routineContracts';

export const WEEKLY_BLOCK_CONTRACT_VERSION = 'v1' as const;

/** The longest title a block may carry, after trimming. */
export const WEEKLY_BLOCK_TITLE_MAX = 120;

/** How far ahead an active block is materialized as busy time. */
export const WEEKLY_BLOCK_HORIZON_WEEKS = 8;

/**
 * How long after a materialization it is renewed. A week, so the horizon never
 * falls below seven weeks, and a missed nightly sweep costs nothing.
 */
export const WEEKLY_BLOCK_RENEW_AFTER_DAYS = 7;

/**
 * How long a past occurrence is kept as busy time before it is pruned. Past
 * occurrences are never *rewritten* — an edit or a pause leaves them exactly as
 * they were — but a block kept for a year must not leave fifty-two rows behind
 * it that every daily plan reads.
 */
export const WEEKLY_BLOCK_HISTORY_DAYS = 28;

/** The widest window the occurrences read will answer for. */
export const WEEKLY_BLOCK_OCCURRENCE_RANGE_MAX_DAYS = 62;

export const WEEKLY_BLOCK_STATUSES = ['active', 'paused'] as const;
export type WeeklyBlockStatus = (typeof WEEKLY_BLOCK_STATUSES)[number];

/** Where a block came from: the weekly-blocks screen, or a confirmed capture. */
export type WeeklyBlockSource = 'manual' | 'capture';

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The stored document, `users/{uid}/weeklyBlocks/{id}`. */
export interface WeeklyBlockDocument {
  readonly id: string;
  readonly title: string;
  /** 0 = Sunday … 6 = Saturday, sorted, distinct, one to seven of them. */
  readonly weekdays: readonly number[];
  /** `HH:MM` on the person's clock in `timezone`. */
  readonly start: string;
  /** `HH:MM`, after `start` on the same day. */
  readonly end: string;
  readonly timezone: string;
  readonly status: WeeklyBlockStatus;
  readonly source: WeeklyBlockSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the person confirmed it. Never set by the server on its own. */
  readonly confirmedAt: string;
  /**
   * The first local date (`YYYY-MM-DD`) on or after the last change to the
   * schedule that falls on one of `weekdays` — where a recurring device event
   * for this block starts.
   */
  readonly startsOn: string;
  /**
   * When the nightly sweep should materialize it again, or null when there is
   * nothing to renew (paused). Operational, not the person's data.
   */
  readonly renewAt: string | null;
}

/** What the routes answer with for one block. */
export interface WeeklyBlockContract {
  readonly id: string;
  readonly title: string;
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly status: WeeklyBlockStatus;
  readonly source: WeeklyBlockSource;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly confirmedAt: string;
  readonly startsOn: string;
  /**
   * Everything the phone needs to write ONE recurring event on the device
   * calendar (RRULE-equivalent: `FREQ=WEEKLY;BYDAY=<weekdays>`, starting
   * `startsOn` at `start`, ending `end`, in `timezone`). Null while paused: the
   * phone removes its device event.
   */
  readonly deviceEvent: WeeklyBlockDeviceEventContract | null;
}

export interface WeeklyBlockDeviceEventContract {
  readonly title: string;
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly startsOn: string;
}

/** One materialized occurrence, for the Calendar tab and Today. */
export interface WeeklyBlockOccurrenceContract {
  /** The busy block's id: stable for as long as the occurrence is unchanged. */
  readonly occurrenceId: string;
  readonly weeklyBlockId: string;
  readonly title: string;
  readonly startAt: string;
  readonly endAt: string;
}

/**
 * A capture item's offer to become a weekly block (the Review card renders
 * «كل سبت · 10:00–16:00»). Present only when the words stated the weekdays
 * and a settled start and end on the same day.
 */
export interface WeeklyBlockOfferContract {
  readonly title: string;
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

/** What `POST /api/mobile/weekly-blocks` accepts, parsed. */
export interface WeeklyBlockInput {
  readonly title: string;
  readonly weekdays: readonly number[];
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
  readonly confirmedAt: string;
}

export interface WeeklyBlockPatch {
  readonly title?: string;
  readonly weekdays?: readonly number[];
  readonly start?: string;
  readonly end?: string;
  readonly status?: WeeklyBlockStatus;
}

export type WeeklyBlockValidationCode =
  | 'invalid_body'
  | 'unknown_field'
  | 'invalid_title'
  | 'invalid_weekdays'
  | 'invalid_time'
  | 'overnight_not_supported'
  | 'invalid_timezone'
  | 'invalid_status'
  | 'confirmation_required'
  | 'empty_patch';

export class WeeklyBlockValidationError extends Error {
  readonly code: WeeklyBlockValidationCode;
  constructor(code: WeeklyBlockValidationCode, message: string) {
    super(message);
    this.name = 'WeeklyBlockValidationError';
    this.code = code;
  }
}

function fail(code: WeeklyBlockValidationCode, message: string): never {
  throw new WeeklyBlockValidationError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refuseUnknown(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) fail('unknown_field', `a weekly block may only carry ${allowed.join(', ')}; this one also carried ${unknown.join(', ')}`);
}

export function parseWeeklyBlockTitle(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  if (title.length < 1 || title.length > WEEKLY_BLOCK_TITLE_MAX) {
    fail('invalid_title', `title must be 1 to ${WEEKLY_BLOCK_TITLE_MAX} characters`);
  }
  return title;
}

export function parseWeeklyBlockWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 7) {
    fail('invalid_weekdays', 'weekdays must list one to seven days, 0 = Sunday … 6 = Saturday');
  }
  if (!value.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    fail('invalid_weekdays', 'each weekday must be an integer from 0 (Sunday) to 6 (Saturday)');
  }
  const days = value as number[];
  if (new Set(days).size !== days.length) fail('invalid_weekdays', 'a weekday may be named once');
  return [...days].sort((a, b) => a - b);
}

export function parseWeeklyBlockClock(value: unknown, field: 'start' | 'end'): string {
  if (typeof value !== 'string' || !CLOCK.test(value)) fail('invalid_time', `${field} must be HH:MM (00:00–23:59)`);
  return value;
}

function minutesOf(clock: string): number {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
}

/** The shape every stored block holds, checked again after a patch is merged. */
export function validateWeeklyBlockShape(shape: { weekdays: unknown; start: unknown; end: unknown }): void {
  parseWeeklyBlockWeekdays(shape.weekdays);
  const start = parseWeeklyBlockClock(shape.start, 'start');
  const end = parseWeeklyBlockClock(shape.end, 'end');
  if (minutesOf(end) <= minutesOf(start)) {
    fail('overnight_not_supported', 'end must be after start on the same day; overnight blocks are not supported yet');
  }
}

const INPUT_KEYS = ['title', 'weekdays', 'start', 'end', 'timezone', 'confirmation'] as const;
const PATCH_KEYS = ['title', 'weekdays', 'start', 'end', 'status'] as const;

export function parseWeeklyBlockInput(body: unknown): WeeklyBlockInput {
  if (!isRecord(body)) fail('invalid_body', 'the request body must be an object');
  refuseUnknown(body, INPUT_KEYS);
  const confirmation = body.confirmation;
  const confirmedAt = isRecord(confirmation) ? confirmation.confirmedByUserAt : undefined;
  if (typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt))) {
    fail('confirmation_required', 'confirmation.confirmedByUserAt is required: a weekly block exists only once a person confirmed it');
  }
  const title = parseWeeklyBlockTitle(body.title);
  const weekdays = parseWeeklyBlockWeekdays(body.weekdays);
  const start = parseWeeklyBlockClock(body.start, 'start');
  const end = parseWeeklyBlockClock(body.end, 'end');
  validateWeeklyBlockShape({ weekdays, start, end });
  if (!isValidTimezone(body.timezone)) fail('invalid_timezone', 'timezone must be an IANA zone');
  return {
    title,
    weekdays,
    start,
    end,
    timezone: (body.timezone as string).trim(),
    confirmedAt: new Date(Date.parse(confirmedAt)).toISOString(),
  };
}

export function parseWeeklyBlockPatch(body: unknown): WeeklyBlockPatch {
  if (!isRecord(body)) fail('invalid_body', 'the request body must be an object');
  refuseUnknown(body, PATCH_KEYS);
  const patch: { -readonly [K in keyof WeeklyBlockPatch]: WeeklyBlockPatch[K] } = {};
  if (body.title !== undefined) patch.title = parseWeeklyBlockTitle(body.title);
  if (body.weekdays !== undefined) patch.weekdays = parseWeeklyBlockWeekdays(body.weekdays);
  if (body.start !== undefined) patch.start = parseWeeklyBlockClock(body.start, 'start');
  if (body.end !== undefined) patch.end = parseWeeklyBlockClock(body.end, 'end');
  if (body.status !== undefined) {
    if (!(WEEKLY_BLOCK_STATUSES as readonly unknown[]).includes(body.status)) fail('invalid_status', 'status must be active or paused');
    patch.status = body.status as WeeklyBlockStatus;
  }
  if (Object.keys(patch).length === 0) fail('empty_patch', 'a patch must change at least one of title, weekdays, start, end, status');
  return patch;
}

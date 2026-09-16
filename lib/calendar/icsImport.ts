/**
 * Reading an ICS calendar into deadlines and busy time (UC-3.4, #188).
 *
 * Pure and standalone on purpose: UC-3.7 (#191) reads a shared `.ics` *file*
 * with the same rules, so nothing in here knows about feeds, users, storage,
 * the network or the clock. `classifyIcs(text, { now, timeZone })` in, three
 * lists out, the same answer every time for the same input.
 *
 * ── The feed is untrusted text ───────────────────────────────────
 *
 * Whoever controls a calendar controls every byte of it, and a university
 * calendar is edited by more people than anyone can vouch for. So:
 *
 * - **No model reads it.** The mapping is deterministic rules, so nothing a
 *   SUMMARY says can be an instruction to anything.
 * - **DESCRIPTION, LOCATION, ATTENDEE, URL and ATTACH are never read.** The
 *   only text that survives is a deadline's SUMMARY, and it is cleaned:
 *   control characters and bidi overrides removed, whitespace collapsed, cut to
 *   120 characters. A busy block carries no text at all.
 * - **A deadline whose title trips `detectPromptInjection` is skipped and
 *   counted**, in Arabic, Hebrew and English alike — the detector is the one
 *   the capture path uses, so the two cannot disagree about what an injection
 *   looks like.
 * - **What comes out is a candidate.** A deadline here is a *proposal*; the
 *   feed service decides whether it may become a commitment, and nothing in a
 *   feed can trigger anything else.
 *
 * ── Deadline or busy ─────────────────────────────────────────────
 *
 * - A VTODO with DUE, not COMPLETED or CANCELLED, is a deadline.
 * - A VEVENT whose start equals its end is a deadline — the Moodle pattern:
 *   "Essay 1 is due" is exported as a zero-length event at the due instant —
 *   *unless* its title says it opens ("Quiz 2 opens"), which Moodle exports in
 *   exactly the same shape and which is not something anybody has to hand in.
 * - A VEVENT whose SUMMARY or CATEGORIES name a deadline (due, deadline,
 *   submission, closes; تسليم, موعد نهائي, آخر موعد; הגשה, מועד אחרון) is a
 *   deadline at its start.
 * - Any other VEVENT with a positive duration that is not TRANSPARENT and not
 *   CANCELLED is busy time. All-day events that are not deadlines are ignored:
 *   #186's rule that a holiday is not twenty-four hours of unavailable time.
 *
 * Deadlines are kept inside `[now, now + 120 days]`, busy time where it
 * overlaps `[now, now + 28 days]`; at most 100 and 500 per calendar, earliest
 * first. Everything left out is counted in `skipped` by reason, so a preview
 * can say "3 deadlines, 12 lectures, 4 skipped" rather than silently dropping.
 *
 * ── Time zones: IANA or the user's, never the feed's own rules ──
 *
 * A TZID is resolved as an IANA name through `Intl` (with a Mozilla-style
 * `/prefix/Region/City` reduced to its tail). A feed's own VTIMEZONE block is
 * deliberately not interpreted: ical.js can only use one by registering it in
 * a process-wide `TimezoneService`, which would let one user's feed redefine
 * "Europe/London" for every feed parsed after it on that instance, and a
 * VTIMEZONE is itself a recurrence rule an attacker can make expensive. A TZID
 * that is not an IANA name (Outlook's "W. Europe Standard Time") and a floating
 * time both fall back to the user's zone, and are counted.
 *
 * ── Recurrence ───────────────────────────────────────────────────
 *
 * RRULE, RDATE, EXDATE and RECURRENCE-ID overrides are expanded by ical.js.
 * Expansion is bounded — 2,000 steps per event, 20,000 per calendar — because
 * `FREQ=SECONDLY` since 1970 is a string anyone can publish.
 */
import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import type { Instant } from '../../src/contracts/v1/planningContracts';
import { detectPromptInjection } from '../../src/extraction/ollamaExtractor';
import { expandRecurrences, parseCalendar } from './icsExpand.mjs';

export const DEADLINE_WINDOW_DAYS = 120;
export const BUSY_WINDOW_DAYS = 28;
export const MAX_DEADLINES = 100;
export const MAX_BUSY = 500;
export const MAX_TITLE_LENGTH = 120;
export { MAX_STEPS_PER_CALENDAR, MAX_STEPS_PER_EVENT } from './icsExpand.mjs';

const DAY_MS = 86_400_000;

export type SkipReason =
  | 'unparseable'
  | 'cancelled'
  | 'completed'
  | 'transparent'
  | 'all_day'
  | 'opens_not_due'
  | 'no_time'
  | 'missing_title'
  | 'prompt_injection'
  | 'outside_window'
  | 'over_cap'
  | 'recurrence_limit'
  | 'unsupported_recurrence'
  | 'timezone_fallback';

export interface DeadlineCandidate {
  /** The calendar's UID for the item (or a digest standing for one it lacked). */
  readonly uid: string;
  /** The occurrence's original start for a recurring item, as an instant; null otherwise. */
  readonly recurrenceId: Instant | null;
  readonly sequence: number;
  readonly dtstamp: Instant | null;
  readonly title: string;
  readonly dueAt: Instant;
  readonly allDay: boolean;
  readonly rule: 'vtodo' | 'zero_duration' | 'keyword';
}

export interface BusyCandidate {
  readonly uid: string;
  readonly recurrenceId: Instant | null;
  readonly startAt: Instant;
  readonly endAt: Instant;
}

export interface IcsClassification {
  readonly deadlines: DeadlineCandidate[];
  readonly busy: BusyCandidate[];
  readonly skipped: { reason: SkipReason; count: number }[];
}

export interface ClassifyIcsOptions {
  readonly now: Date;
  /** The user's IANA zone, for floating times, all-day deadlines and unknown TZIDs. */
  readonly timeZone: string;
  /**
   * Recurrences already expanded elsewhere — by `classifyIcsBounded`'s worker.
   * Absent, they are expanded in this thread, which for an untrusted calendar
   * can fail to terminate; see `icsExpand.mjs`.
   */
  readonly expansion?: RecurrenceExpansion;
}

export interface WallFields {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  isDate: boolean; utc: boolean;
}

export type RecurrenceExpansion = Record<number, {
  occurrences: { recurrence: WallFields; start: WallFields; end: WallFields | null; item: number }[];
  limited: boolean;
}>;

export class IcsParseError extends Error {
  constructor() {
    super('the calendar could not be read');
    this.name = 'IcsParseError';
  }
}

/* ── Text ──────────────────────────────────────────────────────────── */

/**
 * Control characters (C0, DEL, C1) and the bidi embedding/override/isolate
 * controls. LRM and RLM are left alone: they are ordinary punctuation in mixed
 * Arabic or Hebrew and English text and cannot reorder anything on their own.
 */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const points = Array.from(collapsed);
  return points.length > MAX_TITLE_LENGTH ? points.slice(0, MAX_TITLE_LENGTH).join('').trim() : collapsed;
}

/**
 * Arabic written several ways reads as one: tatweel and harakat removed, and
 * alef maksura folded into yeh, so «موعد نهائى» and «مـوعـد نهائي» both match.
 */
function foldArabic(text: string): string {
  return text.replace(/[ـً-ٰٟ]/g, '').replace(/ى/g, 'ي');
}

// `\b` is ASCII-only in JS, which is right for the English words and wrong for
// everything else — so the Arabic and Hebrew alternatives carry no boundary
// and match inside a word: «التسليم» and «להגשה» are the same deadline.
const DEADLINE_WORDS = /\b(?:due|deadline|submission|submit|closes)\b|تسليم|موعد نهائي|آخر موعد|اخر موعد|הגשה|מועד אחרון|דדליין/i;
const OPENS_WORDS = /\bopens?\b|يفتح|تفتح|فتح|נפתח|נפתחת|פתיחת/i;

export function namesDeadline(text: string): boolean {
  return DEADLINE_WORDS.test(foldArabic(text));
}

function namesOpening(text: string): boolean {
  return OPENS_WORDS.test(foldArabic(text)) && !namesDeadline(text);
}

/* ── Time ──────────────────────────────────────────────────────────── */

function isIanaZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `Europe/Berlin`, or `/mozilla.org/20050126_1/Europe/Berlin` reduced to it; null when neither. */
function ianaZoneOf(tzid: string | null): string | null {
  if (!tzid) return null;
  const trimmed = tzid.trim().replace(/^"|"$/g, '');
  if (trimmed.toUpperCase() === 'UTC' || trimmed.toUpperCase() === 'GMT') return 'UTC';
  const parts = trimmed.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    const candidate = parts.slice(i).join('/');
    if (candidate.includes('/') || i === parts.length - 1) {
      if (isIanaZone(candidate)) return candidate;
    }
  }
  return null;
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetMsAt(epochMs: number, zone: string): number {
  let formatter = offsetFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    offsetFormatters.set(zone, formatter);
  }
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** A wall-clock time in an IANA zone, as an instant. Twice-refined for DST edges. */
function wallToEpoch(fields: WallTime, zone: string): number {
  const wall = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  const first = wall - offsetMsAt(wall, zone);
  const second = wall - offsetMsAt(first, zone);
  return second;
}

interface WallTime {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
}

interface Resolution {
  epochMs: number;
  isDate: boolean;
  fellBack: boolean;
}

/**
 * An ical.js time as an instant.
 *
 * UTC when it says UTC; its TZID when that is an IANA zone; otherwise the
 * user's zone, reported as a fallback. `ICAL.Time` is used only for its wall
 * clock fields, never for its own zone arithmetic — see the header.
 */
function resolveTime(time: InstanceType<typeof ICAL.Time>, tzid: string | null, userZone: string): Resolution {
  const fields: WallTime = {
    year: time.year, month: time.month, day: time.day,
    hour: time.isDate ? 0 : time.hour, minute: time.isDate ? 0 : time.minute, second: time.isDate ? 0 : time.second,
  };
  const isUtc = !time.isDate && (time.zone === ICAL.Timezone.utcTimezone || (tzid === null && time.zone?.tzid === 'UTC'));
  if (isUtc) {
    return { epochMs: Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second), isDate: false, fellBack: false };
  }
  const iana = time.isDate ? null : ianaZoneOf(tzid);
  const zone = iana ?? userZone;
  return { epochMs: wallToEpoch(fields, zone), isDate: time.isDate, fellBack: !time.isDate && iana === null };
}

/* ── Classification ────────────────────────────────────────────────── */

type Component = InstanceType<typeof ICAL.Component>;

class Tally {
  private readonly counts = new Map<SkipReason, number>();
  add(reason: SkipReason, by = 1): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + by);
  }
  list(): { reason: SkipReason; count: number }[] {
    return Array.from(this.counts, ([reason, count]) => ({ reason, count }))
      .sort((a, b) => (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0));
  }
}

function textProp(component: Component, name: string): string {
  const value = component.getFirstPropertyValue(name);
  return typeof value === 'string' ? value : '';
}

function categoriesOf(component: Component): string {
  return component.getAllProperties('categories')
    .flatMap((property) => property.getValues())
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function tzidOf(component: Component, name: string): string | null {
  const property = component.getFirstProperty(name);
  const tzid = property?.getParameter('tzid');
  return typeof tzid === 'string' ? tzid : null;
}

function timeProp(component: Component, name: string): InstanceType<typeof ICAL.Time> | null {
  const value = component.getFirstPropertyValue(name);
  return value instanceof ICAL.Time ? value : null;
}

function uidOf(component: Component): string {
  const uid = textProp(component, 'uid').trim();
  if (uid) return uid.slice(0, 512);
  // RFC 5545 requires a UID. A calendar without one still gets a stable key,
  // from the fields that identify the item and nothing it could use to collide
  // with an item that does have one.
  const digest = createHash('sha256')
    .update(JSON.stringify(['no-uid', textProp(component, 'summary'), String(component.getFirstPropertyValue('dtstart') ?? ''), String(component.getFirstPropertyValue('due') ?? '')]))
    .digest('hex');
  return `no-uid:${digest}`;
}

function sequenceOf(component: Component): number {
  const value = component.getFirstPropertyValue('sequence');
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function dtstampOf(component: Component, userZone: string): Instant | null {
  const time = timeProp(component, 'dtstamp');
  if (!time) return null;
  return new Date(resolveTime(time, tzidOf(component, 'dtstamp'), userZone).epochMs).toISOString();
}

function statusOf(component: Component): string {
  return textProp(component, 'status').trim().toUpperCase();
}

/** The last minute of a date in the user's zone: when an all-day deadline is due. */
function endOfLocalDay(time: InstanceType<typeof ICAL.Time>, userZone: string): number {
  return wallToEpoch({ year: time.year, month: time.month, day: time.day, hour: 23, minute: 59, second: 0 }, userZone);
}

/* ── Recurrence rules refused before they are expanded ─────────────── */

const SUB_DAILY = new Set(['SECONDLY', 'MINUTELY', 'HOURLY']);
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function numbers(values: unknown): number[] | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.map(Number).filter((n) => Number.isInteger(n));
}

/** The month (1–12) and day of a BYYEARDAY value in a leap or common year, or null. */
function yearDayDate(yearDay: number, leap: boolean): { month: number; day: number } | null {
  const length = leap ? 366 : 365;
  const ordinal = yearDay > 0 ? yearDay : length + yearDay + 1;
  if (ordinal < 1 || ordinal > length) return null;
  let remaining = ordinal;
  for (let month = 1; month <= 12; month += 1) {
    const days = month === 2 ? (leap ? 29 : 28) : MONTH_DAYS[month - 1]!;
    if (remaining <= days) return { month, day: remaining };
    remaining -= days;
  }
  return null;
}

/**
 * Why a rule is refused before ical.js sees it, or null.
 *
 * ical.js 2.2.1 loops *inside one `next()` call* looking for a date an
 * impossible rule never produces (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30`), so
 * such a rule has to be caught before it is iterated. Sub-daily frequencies
 * are refused outright: a university calendar has no use for them, and
 * `FREQ=SECONDLY;BYMONTH=2` alone costs seconds of CPU per event.
 *
 * This is the cheap half. It cannot see every rule that never yields —
 * `FREQ=DAILY;INTERVAL=7;BYDAY=MO;BYMONTHDAY=1` starting on a Thursday is one —
 * which is why the feed service only ever calls this inside
 * `classifyIcsBounded`'s worker, with a wall clock that can stop it.
 */
export function refusedRecurrence(rule: unknown): string | null {
  if (!(rule instanceof ICAL.Recur)) return null;
  if (SUB_DAILY.has(String(rule.freq))) return 'sub_daily';
  const parts = rule.parts as Record<string, unknown>;
  // RFC 5545 §3.3.10 forbids these pairings, and ical.js does not refuse them:
  // `FREQ=DAILY;BYYEARDAY=-62;BYMONTH=10;BYMONTHDAY=31` names a real date and
  // still never returns from `next()`.
  if (numbers(parts.BYYEARDAY) && rule.freq !== 'YEARLY') return 'invalid';
  if (numbers(parts.BYWEEKNO) && rule.freq !== 'YEARLY') return 'invalid';
  if (numbers(parts.BYMONTHDAY) && rule.freq === 'WEEKLY') return 'invalid';
  // Allowed by the RFC, but ical.js 2.2.1 never returns from `next()` for a
  // negative month day on a daily rule (`FREQ=DAILY;BYMONTHDAY=-1`). The same
  // day as MONTHLY or YEARLY works and is how calendars actually write it.
  if (rule.freq === 'DAILY' && (numbers(parts.BYMONTHDAY) ?? []).some((d) => d < 0)) return 'unsupported';
  const months = numbers(parts.BYMONTH) ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  if (months.some((m) => m < 1 || m > 12)) return 'impossible';
  const monthDays = numbers(parts.BYMONTHDAY);
  const yearDays = numbers(parts.BYYEARDAY);

  const dayFits = (month: number, day: number): boolean => {
    const length = MONTH_DAYS[month - 1]!;
    return day > 0 ? day <= length : day < 0 && -day <= length;
  };
  if (monthDays && !months.some((m) => monthDays.some((d) => dayFits(m, d)))) return 'impossible';

  if (yearDays) {
    const fits = yearDays.some((yd) => [true, false].some((leap) => {
      const date = yearDayDate(yd, leap);
      if (!date || !months.includes(date.month)) return false;
      if (!monthDays) return true;
      const length = date.month === 2 ? (leap ? 29 : 28) : MONTH_DAYS[date.month - 1]!;
      return monthDays.some((d) => (d > 0 ? d === date.day : length + d + 1 === date.day));
    }));
    if (!fits) return 'impossible';
  }
  return null;
}

function rootOrThrow(text: string): Component {
  let root: Component;
  try {
    root = parseCalendar(ICAL, text) as Component;
  } catch {
    throw new IcsParseError();
  }
  if (root.name !== 'vcalendar') throw new IcsParseError();
  return root;
}

function timeOf(fields: WallFields): InstanceType<typeof ICAL.Time> {
  const data = { year: fields.year, month: fields.month, day: fields.day, hour: fields.hour, minute: fields.minute, second: fields.second, isDate: fields.isDate };
  return fields.utc ? new ICAL.Time(data, ICAL.Timezone.utcTimezone) : ICAL.Time.fromData(data);
}

/** True — and counted by the caller — when any RRULE of this event is refused. */
function refusedRule(master: Component): boolean {
  return master.getAllProperties('rrule').some((property) => refusedRecurrence(property.getFirstValue()) !== null);
}

interface MasterIndex {
  events: Component[];
  masters: Map<string, { component: Component; index: number }>;
  overridesByUid: Map<string, Component[]>;
  /** Indexes of the masters that need expanding and are not refused. */
  recurring: number[];
}

function recurringMasters(root: Component, tally: Tally | null): MasterIndex {
  const events = root.getAllSubcomponents('vevent');
  const masters = new Map<string, { component: Component; index: number }>();
  // Grouped once. Filtering every override for every master was quadratic, and
  // a 2 MiB feed of both took seconds.
  const overridesByUid = new Map<string, Component[]>();
  events.forEach((event, index) => {
    if (event.hasProperty('recurrence-id')) {
      const key = uidOf(event);
      const group = overridesByUid.get(key);
      if (group) group.push(event);
      else overridesByUid.set(key, [event]);
    } else {
      masters.set(uidOf(event), { component: event, index });
    }
  });
  const recurring: number[] = [];
  for (const { component, index } of Array.from(masters.values())) {
    if (!component.hasProperty('rrule') && !component.hasProperty('rdate')) continue;
    if (component.hasProperty('rrule') && refusedRule(component)) {
      tally?.add('unsupported_recurrence');
      continue;
    }
    recurring.push(index);
  }
  return { events, masters, overridesByUid, recurring };
}

/**
 * What `classifyIcsBounded` sends to its worker: the indexes to expand and how
 * far. Parsing is linear and safe on this thread; only expansion is not.
 */
export function expansionRequest(text: string, options: Pick<ClassifyIcsOptions, 'now'>): { masters: number[]; horizonMs: number } {
  const nowMs = options.now.getTime();
  const { recurring } = recurringMasters(rootOrThrow(text), null);
  return { masters: recurring, horizonMs: nowMs + Math.max(DEADLINE_WINDOW_DAYS, BUSY_WINDOW_DAYS) * DAY_MS };
}

export function classifyIcs(text: string, options: ClassifyIcsOptions): IcsClassification {
  const nowMs = options.now.getTime();
  const userZone = isIanaZone(options.timeZone) ? options.timeZone : 'UTC';
  const deadlineEnd = nowMs + DEADLINE_WINDOW_DAYS * DAY_MS;
  const busyEnd = nowMs + BUSY_WINDOW_DAYS * DAY_MS;
  const tally = new Tally();

  const root = rootOrThrow(text);

  const deadlines: DeadlineCandidate[] = [];
  const busy: BusyCandidate[] = [];

  /* VTODO */
  for (const todo of root.getAllSubcomponents('vtodo')) {
    try {
      const status = statusOf(todo);
      if (status === 'CANCELLED') { tally.add('cancelled'); continue; }
      if (status === 'COMPLETED' || todo.hasProperty('completed')) { tally.add('completed'); continue; }
      const due = timeProp(todo, 'due');
      if (!due) { tally.add('no_time'); continue; }
      const resolved = resolveTime(due, tzidOf(todo, 'due'), userZone);
      if (resolved.fellBack) tally.add('timezone_fallback');
      const dueMs = resolved.isDate ? endOfLocalDay(due, userZone) : resolved.epochMs;
      pushDeadline(deadlines, tally, {
        uid: uidOf(todo), recurrenceId: null, sequence: sequenceOf(todo), dtstamp: dtstampOf(todo, userZone),
        rawTitle: textProp(todo, 'summary'), dueMs, allDay: resolved.isDate, rule: 'vtodo',
      }, nowMs, deadlineEnd);
    } catch {
      tally.add('unparseable');
    }
  }

  /* VEVENT: masters, expanded with their overrides; then orphan overrides alone */
  const { events, masters, overridesByUid, recurring } = recurringMasters(root, tally);
  const overrides = Array.from(overridesByUid.values()).flat();
  const horizonMs = Math.max(deadlineEnd, busyEnd);
  const expansion: RecurrenceExpansion = options.expansion
    ?? (expandRecurrences(ICAL, text, { masters: recurring, horizonMs }) as unknown as RecurrenceExpansion);

  for (const [uid, { component: master, index }] of Array.from(masters)) {
    try {
      if (master.hasProperty('rrule') && refusedRule(master)) continue;
      if (!master.hasProperty('rrule') && !master.hasProperty('rdate')) {
        classifyOccurrence(master, uid, null, timeProp(master, 'dtstart'), null);
        continue;
      }
      const expanded = expansion[index];
      if (!expanded) {
        tally.add('unparseable');
        continue;
      }
      if (expanded.limited) tally.add('recurrence_limit');
      for (const occurrence of expanded.occurrences) {
        const startResolved = resolveTime(timeOf(occurrence.recurrence), tzidOf(master, 'dtstart'), userZone);
        if (startResolved.epochMs > horizonMs) break;
        const item = events[occurrence.item] ?? master;
        const recurrenceId = new Date(startResolved.epochMs).toISOString();
        classifyOccurrence(item, uid, recurrenceId, timeOf(occurrence.start), occurrence.end ? timeOf(occurrence.end) : null);
      }
    } catch {
      tally.add('unparseable');
    }
  }
  // An override whose master is not in this file (a feed that publishes only
  // the changed instance) is read as a single event of its own.
  for (const override of overrides) {
    const uid = uidOf(override);
    if (masters.get(uid)?.component.hasProperty('rrule')) continue;
    try {
      const recurrence = timeProp(override, 'recurrence-id');
      const recurrenceId = recurrence
        ? new Date(resolveTime(recurrence, tzidOf(override, 'recurrence-id'), userZone).epochMs).toISOString()
        : null;
      classifyOccurrence(override, uid, recurrenceId, timeProp(override, 'dtstart'), null);
    } catch {
      tally.add('unparseable');
    }
  }

  function classifyOccurrence(
    item: Component,
    uid: string,
    recurrenceId: Instant | null,
    start: InstanceType<typeof ICAL.Time> | null,
    endFromExpansion: InstanceType<typeof ICAL.Time> | null,
  ): void {
    if (!start) { tally.add('no_time'); return; }
    if (statusOf(item) === 'CANCELLED') { tally.add('cancelled'); return; }

    const startTzid = tzidOf(item, 'dtstart');
    const startResolved = resolveTime(start, startTzid, userZone);
    if (startResolved.fellBack) tally.add('timezone_fallback');

    let endMs: number;
    const endTime = endFromExpansion ?? timeProp(item, 'dtend');
    if (endTime) {
      endMs = resolveTime(endTime, tzidOf(item, 'dtend') ?? startTzid, userZone).epochMs;
    } else {
      const duration = item.getFirstPropertyValue('duration');
      if (duration instanceof ICAL.Duration) {
        endMs = startResolved.epochMs + duration.toSeconds() * 1000;
      } else {
        // RFC 5545 §3.6.1: no DTEND and no DURATION is one day for a DATE and
        // zero length for a DATE-TIME.
        endMs = startResolved.isDate ? startResolved.epochMs + DAY_MS : startResolved.epochMs;
      }
    }

    const summary = textProp(item, 'summary');
    const keyword = namesDeadline(`${summary} ${categoriesOf(item)}`);
    const zeroLength = !startResolved.isDate && endMs === startResolved.epochMs;

    if (keyword || zeroLength) {
      if (!keyword && namesOpening(summary)) { tally.add('opens_not_due'); return; }
      const dueMs = startResolved.isDate ? endOfLocalDay(start, userZone) : startResolved.epochMs;
      pushDeadline(deadlines, tally, {
        uid, recurrenceId, sequence: sequenceOf(item), dtstamp: dtstampOf(item, userZone),
        rawTitle: summary, dueMs, allDay: startResolved.isDate, rule: keyword ? 'keyword' : 'zero_duration',
      }, nowMs, deadlineEnd);
      return;
    }

    if (startResolved.isDate) { tally.add('all_day'); return; }
    if (textProp(item, 'transp').trim().toUpperCase() === 'TRANSPARENT') { tally.add('transparent'); return; }
    if (endMs <= startResolved.epochMs) { tally.add('no_time'); return; }
    if (endMs <= nowMs || startResolved.epochMs >= busyEnd) { tally.add('outside_window'); return; }
    busy.push({
      uid,
      recurrenceId,
      startAt: new Date(startResolved.epochMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
    });
  }

  const byDue = (a: DeadlineCandidate, b: DeadlineCandidate): number =>
    a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  const byStart = (a: BusyCandidate, b: BusyCandidate): number =>
    a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;

  deadlines.sort(byDue);
  busy.sort(byStart);
  if (deadlines.length > MAX_DEADLINES) tally.add('over_cap', deadlines.length - MAX_DEADLINES);
  if (busy.length > MAX_BUSY) tally.add('over_cap', busy.length - MAX_BUSY);

  return {
    deadlines: deadlines.slice(0, MAX_DEADLINES),
    busy: busy.slice(0, MAX_BUSY),
    skipped: tally.list(),
  };
}

function pushDeadline(
  into: DeadlineCandidate[],
  tally: Tally,
  input: {
    uid: string; recurrenceId: Instant | null; sequence: number; dtstamp: Instant | null;
    rawTitle: string; dueMs: number; allDay: boolean; rule: DeadlineCandidate['rule'];
  },
  nowMs: number,
  windowEnd: number,
): void {
  if (input.dueMs < nowMs || input.dueMs > windowEnd) { tally.add('outside_window'); return; }
  // The raw SUMMARY is what is checked, before cleaning: a payload hidden
  // behind a bidi override is still the payload.
  if (detectPromptInjection(input.rawTitle) !== null) { tally.add('prompt_injection'); return; }
  const title = cleanTitle(input.rawTitle);
  if (title === '' || detectPromptInjection(title) !== null) {
    tally.add(title === '' ? 'missing_title' : 'prompt_injection');
    return;
  }
  into.push({
    uid: input.uid,
    recurrenceId: input.recurrenceId,
    sequence: input.sequence,
    dtstamp: input.dtstamp,
    title,
    dueAt: new Date(input.dueMs).toISOString(),
    allDay: input.allDay,
    rule: input.rule,
  });
}

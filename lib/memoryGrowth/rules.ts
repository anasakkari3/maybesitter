/**
 * Deterministic memory growth: what MaybeSitter may *suggest* it noticed
 * (UC-3.16, #202).
 *
 * ── What a rule is allowed to read ───────────────────────────────
 *
 * Instants and ids. A rule sees that something was finished and when, and
 * nothing about *what* it was: no name, no notes, no category. The boundary
 * test in `tests/memoryGrowth/rules.test.ts` greps this directory for the word
 * a commitment's name is stored under, so a rule that started reading one
 * fails the run rather than a review.
 *
 * ── Pure, and clock-free ─────────────────────────────────────────
 *
 * `now` is an argument. The same observations, zone and `now` give the same
 * suggestion byte for byte, in any input order — which is what lets a
 * dismissal be keyed to a fingerprint and mean something the next day.
 *
 * ── Suggested, never saved ───────────────────────────────────────
 *
 * Nothing here writes. A suggestion is computed on read and exists only in the
 * response; it becomes memory only when the user presses Keep, and the store
 * write lives in `suggestionService.ts`, not here.
 *
 * ── Which rules exist ────────────────────────────────────────────
 *
 * R1 (focus window), R2 (the usual "Later" duration, UC-3.14 (#200)'s defer —
 * #532) and R3 (when the plan is usually opened — #533). R3's input is a
 * record of the plan being *opened*, which the daily plan ledger learned to
 * write in #533 (`plan_opened` in `users/{uid}/planEvents` — the ledger, not
 * the domain log, for the reason planStore's header gives). It is not
 * approximated from something adjacent like `plan_accepted`: a rule fed a
 * stand-in would suggest a sentence about the person that the data behind it
 * does not say.
 */

export const R1_FOCUS_WINDOW = 'R1_focus_window' as const;
export const R2_DEFER_DEFAULT = 'R2_defer_default' as const;
export const R3_PLAN_TIME = 'R3_plan_time' as const;

export type MemoryGrowthRuleId = typeof R1_FOCUS_WINDOW | typeof R2_DEFER_DEFAULT | typeof R3_PLAN_TIME;

export const MEMORY_GROWTH_RULE_IDS: readonly MemoryGrowthRuleId[] = [R1_FOCUS_WINDOW, R2_DEFER_DEFAULT, R3_PLAN_TIME];

/** How far back R1 looks. */
export const R1_LOOKBACK_DAYS = 28;
/** Fewer distinct things finished than this, and there is no pattern to name. */
export const R1_MIN_COMPLETIONS = 8;
/** The share of them one window has to hold. */
export const R1_MIN_SHARE = 0.6;
/** The width of the window, in minutes. */
export const R1_WINDOW_MINUTES = 180;

/** How far back R2 looks — the same range read R1's events come from. */
export const R2_LOOKBACK_DAYS = 28;
/** The newest defers R2 judges. Fewer than this many in the log, and there is no "usually" to name. */
export const R2_DEFER_WINDOW = 6;
/** How many of those one duration has to hold. */
export const R2_MIN_DEFER_MATCHES = 4;
/**
 * Defer durations are rounded to this, in minutes, before they are counted.
 * Exact equality would read the same habit — "an hour" picked at 12:03 and at
 * 12:31 — as two, so a defer counts toward the bucket nearest its length.
 */
export const R2_BUCKET_MINUTES = 30;

/** How far back R3 looks — the same range R1 and R2 read. */
export const R3_LOOKBACK_DAYS = 28;
/** The newest plan days R3 judges. Fewer than this many opened in the lookback, and there is no "usually" to name. */
export const R3_PLAN_DAYS_WINDOW = 7;
/** How many of those days one time bucket has to hold. */
export const R3_MIN_DAY_MATCHES = 5;
/**
 * The width of the bucket two opens fall into when they are "the same time",
 * in minutes. Exact equality would read the same habit — 08:12 one day and
 * 08:26 the next — as two, so opens count toward the half-hour they fall in.
 */
export const R3_SAME_TIME_MINUTES = 30;
/**
 * An open this close to the plan's own `deliveryLocalTime` is the delivery
 * being read, not a habit, and does not count (#533's spec).
 */
export const R3_DELIVERY_EXCLUSION_MINUTES = 20;

const MS_PER_DAY = 86_400_000;
const MINUTES_PER_DAY = 1440;

/** One thing the user finished: the event id, when, and which item. */
export interface CompletionObservation {
  readonly id: string;
  readonly at: string;
  readonly commitmentId: string;
}

export interface LocalWindow {
  /** `HH:MM`, on the hour. */
  readonly start: string;
  /** `HH:MM`, on the hour, three hours after `start`, never past midnight. */
  readonly end: string;
}

export interface FocusWindowSuggestion {
  readonly ruleId: typeof R1_FOCUS_WINDOW;
  /**
   * What the suggestion *claims*, and nothing else. A dismissal is keyed to it,
   * so it must not move when one more completion lands inside the same window —
   * which is why it carries the window and not a count or an evidence id.
   */
  readonly fingerprint: string;
  readonly window: LocalWindow;
  /** The share of distinct completions inside the window, 0..1. */
  readonly confidence: number;
  /** The completion events inside the window, oldest first. */
  readonly evidenceIds: readonly string[];
  readonly matchingCount: number;
  readonly totalCount: number;
  readonly lookbackDays: number;
}

/**
 * R1: "You often finish things between 09:00 and 12:00."
 *
 * At least eight distinct things finished in the last 28 days, and at least
 * 60% of them inside one three-hour local window.
 *
 * ── Distinct things, not events ──────────────────────────────────
 *
 * A commitment completed, reopened and completed again is one thing finished.
 * Counting the events would let a single item toggled back and forth
 * manufacture a pattern. Its latest completion is the one that counts.
 *
 * ── Which window ─────────────────────────────────────────────────
 *
 * Windows start on the hour and never wrap midnight, because the planning
 * `WorkingWindow` this may become a hint for forbids wrapping. The window
 * holding the most wins; among windows holding the same number, the one whose
 * centre is nearest the median of what it holds, then the earliest. "Earliest"
 * alone would describe a habit at 09:30 as "between 07:00 and 10:00", which is
 * true and is not what anyone would say.
 *
 * ── Local time ───────────────────────────────────────────────────
 *
 * Each instant is read in `timeZone` at its own moment, so a habit that stays
 * at 09:30 across a daylight-saving change stays in one window.
 */
export function suggestFocusWindow(
  observations: readonly CompletionObservation[],
  timeZone: string,
  now: string,
): FocusWindowSuggestion | null {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  const fromMs = nowMs - R1_LOOKBACK_DAYS * MS_PER_DAY;

  // Latest completion per commitment, inside [now - 28d, now).
  const latest = new Map<string, { id: string; atMs: number }>();
  observations.forEach((observation) => {
    const atMs = Date.parse(observation.at);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs >= nowMs) return;
    const current = latest.get(observation.commitmentId);
    if (!current || atMs > current.atMs || (atMs === current.atMs && observation.id > current.id)) {
      latest.set(observation.commitmentId, { id: observation.id, atMs });
    }
  });

  const counted: Array<{ id: string; atMs: number; minute: number }> = [];
  latest.forEach((entry) => {
    counted.push({ ...entry, minute: localMinuteOfDay(entry.atMs, timeZone) });
  });
  counted.sort((left, right) => left.atMs - right.atMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const total = counted.length;
  if (total < R1_MIN_COMPLETIONS) return null;

  let best: { startMinute: number; inside: typeof counted; distance: number } | null = null;
  for (let startMinute = 0; startMinute + R1_WINDOW_MINUTES <= MINUTES_PER_DAY; startMinute += 60) {
    const endMinute = startMinute + R1_WINDOW_MINUTES;
    const inside = counted.filter((entry) => entry.minute >= startMinute && entry.minute < endMinute);
    if (inside.length === 0) continue;
    const distance = Math.abs(startMinute + R1_WINDOW_MINUTES / 2 - lowerMedian(inside.map((entry) => entry.minute)));
    if (
      !best
      || inside.length > best.inside.length
      || (inside.length === best.inside.length && distance < best.distance)
    ) {
      best = { startMinute, inside, distance };
    }
  }

  if (!best) return null;
  const share = best.inside.length / total;
  if (share < R1_MIN_SHARE) return null;

  const window = {
    start: hhmm(best.startMinute),
    end: hhmm(best.startMinute + R1_WINDOW_MINUTES),
  };
  return {
    ruleId: R1_FOCUS_WINDOW,
    fingerprint: focusWindowFingerprint(window),
    window,
    // Two decimals: a share of small integers, stored as the number a person
    // would say rather than as 0.7000000000000001.
    confidence: Math.round(share * 100) / 100,
    evidenceIds: best.inside.map((entry) => entry.id),
    matchingCount: best.inside.length,
    totalCount: total,
    lookbackDays: R1_LOOKBACK_DAYS,
  };
}

export function focusWindowFingerprint(window: LocalWindow): string {
  return `${R1_FOCUS_WINDOW}:${window.start}-${window.end}`;
}

/** One "Later": the event id, when it was said, and when it was pushed to. */
export interface DeferObservation {
  readonly id: string;
  readonly at: string;
  readonly postponedUntil: string;
}

export interface DeferDefaultSuggestion {
  readonly ruleId: typeof R2_DEFER_DEFAULT;
  /**
   * What the suggestion *claims*, and nothing else — the winning duration
   * bucket, never a count or an evidence id, so one more defer of the same
   * length does not resurrect a claim the user turned down.
   */
  readonly fingerprint: string;
  /** The duration the user usually defers by, in minutes, a multiple of `R2_BUCKET_MINUTES`. */
  readonly deferMinutes: number;
  /** The share of the counted defers that bucket holds, 0..1. */
  readonly confidence: number;
  /** The defer events inside the bucket, oldest first. */
  readonly evidenceIds: readonly string[];
  readonly matchingCount: number;
  readonly totalCount: number;
  readonly lookbackDays: number;
}

/**
 * R2: "When you push something later, it's usually by 1 hour."
 *
 * The six newest defers in the lookback, and at least four of them in the same
 * half-hour duration bucket. Fewer than six defers in the log is not a pattern
 * that failed its threshold; it is a person who rarely says "later", and there
 * is nothing to name.
 *
 * ── The duration, and why it is bucketed ─────────────────────────
 *
 * The length of a defer is `postponedUntil − at`, both instants, so a daylight
 * shift or a zone never enters into it. Buckets are half-hour wide and centred
 * on the hour and half-hour — a defer of 45 up to 74 minutes counts as one
 * hour — because the pickers offer "in an hour" and "tomorrow morning", and
 * the second of those is a different length every time it is tapped. Anything
 * under fifteen minutes rounds into the half-hour bucket rather than claiming
 * a duration of zero.
 *
 * With six events and a threshold of four, two buckets can never both qualify,
 * so there is no tie to break.
 */
export function suggestDeferDefault(
  observations: readonly DeferObservation[],
  now: string,
): DeferDefaultSuggestion | null {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  const fromMs = nowMs - R2_LOOKBACK_DAYS * MS_PER_DAY;

  const defers: Array<{ id: string; atMs: number; minutes: number }> = [];
  observations.forEach((observation) => {
    const atMs = Date.parse(observation.at);
    const untilMs = Date.parse(observation.postponedUntil);
    if (!Number.isFinite(atMs) || !Number.isFinite(untilMs)) return;
    if (atMs < fromMs || atMs >= nowMs) return;
    const durationMs = untilMs - atMs;
    if (durationMs <= 0) return;
    const minutes = Math.round(durationMs / (R2_BUCKET_MINUTES * 60_000)) * R2_BUCKET_MINUTES;
    defers.push({ id: observation.id, atMs, minutes: Math.max(R2_BUCKET_MINUTES, minutes) });
  });
  defers.sort((left, right) => left.atMs - right.atMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const counted = defers.slice(-R2_DEFER_WINDOW);
  const total = counted.length;
  if (total < R2_DEFER_WINDOW) return null;

  const buckets: Array<{ minutes: number; inside: typeof counted }> = [];
  counted.forEach((defer) => {
    const bucket = buckets.find((candidate) => candidate.minutes === defer.minutes);
    if (bucket) bucket.inside.push(defer);
    else buckets.push({ minutes: defer.minutes, inside: [defer] });
  });

  const winner = buckets.find((bucket) => bucket.inside.length >= R2_MIN_DEFER_MATCHES);
  if (!winner) return null;

  const share = winner.inside.length / total;
  return {
    ruleId: R2_DEFER_DEFAULT,
    fingerprint: deferDefaultFingerprint(winner.minutes),
    deferMinutes: winner.minutes,
    confidence: Math.round(share * 100) / 100,
    evidenceIds: winner.inside.map((defer) => defer.id),
    matchingCount: winner.inside.length,
    totalCount: total,
    lookbackDays: R2_LOOKBACK_DAYS,
  };
}

export function deferDefaultFingerprint(deferMinutes: number): string {
  return `${R2_DEFER_DEFAULT}:${deferMinutes}m`;
}

const R2_FINGERPRINT = /^R2_defer_default:([0-9]+)m$/;

/**
 * The duration a fingerprint names, or null for anything this module could not
 * have written: not a positive multiple of the bucket width, or another rule's.
 * The same discipline as `parseFocusWindowFingerprint` — a hand-edited or
 * future-format value is refused rather than half-understood.
 */
export function parseDeferDefaultFingerprint(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = R2_FINGERPRINT.exec(value);
  if (!match) return null;
  const minutes = Number(match[1]);
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes % R2_BUCKET_MINUTES !== 0) return null;
  return minutes;
}

/** One plan being put on screen: the event id, when, and which plan day. */
export interface PlanOpenObservation {
  readonly id: string;
  readonly at: string;
  /** The plan's own local date, `YYYY-MM-DD` — the day this open counts for. */
  readonly planDate: string;
}

export interface PlanTimeSuggestion {
  readonly ruleId: typeof R3_PLAN_TIME;
  /**
   * What the suggestion *claims*, and nothing else — the winning half-hour,
   * never a count or an evidence id, so one more open at the same time does
   * not resurrect a claim the user turned down.
   */
  readonly fingerprint: string;
  /** The time the user usually opens their plan, `HH:MM`, on the hour or half-hour. */
  readonly planTime: string;
  /** The share of the counted plan days that half-hour holds, 0..1. */
  readonly confidence: number;
  /** The open events inside the half-hour, oldest first. */
  readonly evidenceIds: readonly string[];
  readonly matchingCount: number;
  readonly totalCount: number;
  readonly lookbackDays: number;
}

/**
 * R3: "You usually look at your plan around 08:30." (#533)
 *
 * The seven newest plan days with a recorded open in the lookback, and at
 * least five of them first opened in the same local half-hour. Fewer than
 * seven opened days is not a pattern that failed its threshold; it is a
 * person who rarely looks, and there is nothing to name.
 *
 * ── One open per plan day ────────────────────────────────────────
 *
 * The first open of the day is the one that says when the person looks at
 * their plan; counting every open would let one restless evening outweigh a
 * week of mornings. Days are counted, not opens, so a screen left open and
 * reopened cannot manufacture a pattern.
 *
 * ── The delivery is not a habit ──────────────────────────────────
 *
 * An open within `R3_DELIVERY_EXCLUSION_MINUTES` of the plan's own
 * `deliveryLocalTime` — either side, across midnight — is the morning
 * notification being read, not a time the person chose. Those opens are
 * removed *before* the day's first open is picked: a day opened at the
 * delivery and again at noon counts as a noon day.
 *
 * With seven days and a threshold of five, two half-hours can never both
 * qualify, so there is no tie to break.
 */
export function suggestPlanTime(
  observations: readonly PlanOpenObservation[],
  deliveryLocalTime: string,
  timeZone: string,
  now: string,
): PlanTimeSuggestion | null {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;
  const fromMs = nowMs - R3_LOOKBACK_DAYS * MS_PER_DAY;
  const deliveryMinute = parseHhmm(deliveryLocalTime);

  // First non-delivery open per plan day, inside [now - 28d, now).
  const firstByDay = new Map<string, { id: string; atMs: number }>();
  observations.forEach((observation) => {
    const atMs = Date.parse(observation.at);
    if (!Number.isFinite(atMs) || atMs < fromMs || atMs >= nowMs) return;
    const minute = localMinuteOfDay(atMs, timeZone);
    if (deliveryMinute !== null && circularMinuteDistance(minute, deliveryMinute) <= R3_DELIVERY_EXCLUSION_MINUTES) return;
    const current = firstByDay.get(observation.planDate);
    if (!current || atMs < current.atMs || (atMs === current.atMs && observation.id < current.id)) {
      firstByDay.set(observation.planDate, { id: observation.id, atMs });
    }
  });

  const days: Array<{ planDate: string; id: string; atMs: number; bucket: number }> = [];
  firstByDay.forEach((open, planDate) => {
    days.push({
      planDate,
      ...open,
      bucket: Math.floor(localMinuteOfDay(open.atMs, timeZone) / R3_SAME_TIME_MINUTES) * R3_SAME_TIME_MINUTES,
    });
  });
  days.sort((left, right) => right.planDate.localeCompare(left.planDate) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  const counted = days.slice(0, R3_PLAN_DAYS_WINDOW);
  const total = counted.length;
  if (total < R3_PLAN_DAYS_WINDOW) return null;

  const buckets: Array<{ minute: number; inside: typeof counted }> = [];
  counted.forEach((day) => {
    const bucket = buckets.find((candidate) => candidate.minute === day.bucket);
    if (bucket) bucket.inside.push(day);
    else buckets.push({ minute: day.bucket, inside: [day] });
  });

  const winner = buckets.find((bucket) => bucket.inside.length >= R3_MIN_DAY_MATCHES);
  if (!winner) return null;

  const share = winner.inside.length / total;
  const evidence = [...winner.inside].sort((left, right) => left.atMs - right.atMs || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    ruleId: R3_PLAN_TIME,
    fingerprint: planTimeFingerprint(hhmm(winner.minute)),
    planTime: hhmm(winner.minute),
    confidence: Math.round(share * 100) / 100,
    evidenceIds: evidence.map((day) => day.id),
    matchingCount: winner.inside.length,
    totalCount: total,
    lookbackDays: R3_LOOKBACK_DAYS,
  };
}

export function planTimeFingerprint(planTime: string): string {
  return `${R3_PLAN_TIME}:${planTime}`;
}

const R3_FINGERPRINT = /^R3_plan_time:([0-2][0-9]):([03]0)$/;

/**
 * The time a fingerprint names, or null for anything this module could not
 * have written: not on the hour or half-hour, past 23:30, or another rule's.
 * The same discipline as `parseDeferDefaultFingerprint` — a hand-edited or
 * future-format value is refused rather than half-understood.
 */
export function parsePlanTimeFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = R3_FINGERPRINT.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  return `${match[1]}:${match[2]}`;
}

/** `HH:mm` as a minute of the day, or null for anything else. */
function parseHhmm(value: string): number | null {
  const match = /^([0-2][0-9]):([0-5][0-9])$/.exec(value);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute < MINUTES_PER_DAY ? minute : null;
}

/** The shorter distance between two minutes of the day, across midnight. */
function circularMinuteDistance(left: number, right: number): number {
  const apart = Math.abs(left - right);
  return Math.min(apart, MINUTES_PER_DAY - apart);
}

const FINGERPRINT = /^R1_focus_window:([0-2][0-9]):00-([0-2][0-9]):00$/;

/**
 * The window a fingerprint names, or null for anything this module could not
 * have written: off the hour, the wrong width, wrapping midnight, or another
 * rule's. The planner reads a kept window through this, so a hand-edited or
 * future-format value is refused rather than half-understood.
 */
export function parseFocusWindowFingerprint(value: unknown): LocalWindow | null {
  if (typeof value !== 'string') return null;
  const match = FINGERPRINT.exec(value);
  if (!match) return null;
  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (startHour * 60 + R1_WINDOW_MINUTES !== endHour * 60) return null;
  if (endHour > 24) return null;
  return { start: hhmm(startHour * 60), end: hhmm(endHour * 60) };
}

/** `HH:MM` for a minute of the day; 1440 is written `24:00`. */
function hhmm(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${hours < 10 ? '0' : ''}${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

function lowerMedian(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * The wall-clock minute `timeZone` showed at `epochMs`.
 *
 * `formatToParts` with `hourCycle: 'h23'` rather than an offset: an offset
 * read once and applied to every instant is exactly how a habit gets split in
 * two by a daylight-saving change.
 */
function localMinuteOfDay(epochMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

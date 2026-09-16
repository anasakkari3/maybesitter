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
 * R1 (focus window) only. #202 also describes R2 (the usual "Later" duration)
 * and R3 (when the plan is usually opened). R2's input is UC-3.14 (#200)'s
 * defer, which is not on main; R3's input is a record of the plan being
 * *opened*, which nothing in this repository writes — the daily plan records
 * accept, dismiss and edit, not a view. Neither is approximated from something
 * adjacent: a rule fed a stand-in would suggest a sentence about the person
 * that the data behind it does not say.
 */

export const R1_FOCUS_WINDOW = 'R1_focus_window' as const;

export type MemoryGrowthRuleId = typeof R1_FOCUS_WINDOW;

export const MEMORY_GROWTH_RULE_IDS: readonly MemoryGrowthRuleId[] = [R1_FOCUS_WINDOW];

/** How far back R1 looks. */
export const R1_LOOKBACK_DAYS = 28;
/** Fewer distinct things finished than this, and there is no pattern to name. */
export const R1_MIN_COMPLETIONS = 8;
/** The share of them one window has to hold. */
export const R1_MIN_SHARE = 0.6;
/** The width of the window, in minutes. */
export const R1_WINDOW_MINUTES = 180;

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

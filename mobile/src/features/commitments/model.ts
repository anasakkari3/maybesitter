/**
 * The server's commitment, as the screens read it (UC-2.R3, #173).
 *
 * ── One mapping, in one place ────────────────────────────────────
 *
 * `priority.level` is `low | normal | high` and the design shows Must, Should
 * and Nice. `status` is the domain's and the design's is smaller. Every screen
 * needs both translations, and two screens translating independently is how
 * "dropped" ends up meaning something different on Today than it does on
 * Details.
 *
 * ── There is no "overdue" ────────────────────────────────────────
 *
 * The design fixes this and the copy depends on it: an item is active, done,
 * moved, or dropped on purpose. A commitment whose time has passed is still
 * *active* — the product's whole position is that a missed thing is not a
 * failure state. `isPast` exists so ranking and the reason line can say "this
 * one first", and it is deliberately not a status.
 */
import type { Commitment } from '../../api/schemas/common';
import { dayKey, formatTime, type FormatOptions } from '../../i18n/format';
import { ltr } from '../../i18n/strings';
import { resolveTimeZone } from '../../i18n/timezone';

export type Importance = 'must' | 'should' | 'nice';

/** What the design draws. Fewer states than the domain has, on purpose. */
export type ViewStatus = 'active' | 'done' | 'dropped';

export interface CommitmentView {
  id: string;
  title: string;
  importance: Importance;
  status: ViewStatus;
  /** The instant the screen shows: the due time, or the reminder if that is all there is. */
  shownAt: string | null;
  /**
   * Where a saved plan puts it, when one does (`features/plan/savedPlacement`):
   * the screens show it at this time, and its own due beside it when the two
   * differ (post-UAT FX1). Absent for anything no saved day holds.
   */
  plannedAt?: string | null;
  /**
   * The commitment names a day and no hour (`TimeSpec.allDay`): `shownAt` is
   * that day's local midnight, which nobody chose. Show its day, never «00:00»
   * (FX3). Optional so a view built by hand reads as timed.
   */
  allDay?: boolean;
  /**
   * An appointment on a day with no hour (`scheduled_event` + `allDay`): it
   * happens on its day, and is never «خطوتك التالية» (final UAT, N18). An
   * all-day *task* is still something to do by the day's end. Optional so a
   * view built by hand reads as neither.
   */
  allDayEvent?: boolean;
  /** Separate from the due time: postponing pauses resurfacing, not the deadline. */
  postponedUntil?: string | null;
  /** Past its shown time, and still active. Not a status — see the header. */
  isPast: boolean;
  /** The user chose this importance; it was not read off their words. */
  importanceIsStated: boolean;
  /** From UC-2.8 (#169). Absent when this build does not rank. */
  rank: number | undefined;
  reasonCodes: readonly string[];
}

const IMPORTANCE: Record<Commitment['priority']['level'], Importance> = {
  high: 'must',
  normal: 'should',
  low: 'nice',
};

/**
 * Every domain status the lists can receive, mapped to what the design draws.
 *
 * Written as a total record rather than a switch with a default, so a status
 * added to the domain fails the typecheck here instead of quietly rendering as
 * "active" — which is the mapping that would hide a cancelled item among the
 * live ones.
 */
const STATUS: Record<string, ViewStatus> = {
  active: 'active',
  pending_confirmation: 'active',
  postponed: 'active',
  completed: 'done',
  dropped: 'dropped',
  cancelled: 'dropped',
  missed: 'active',
  archived: 'dropped',
};

export function toViewModel(commitment: Commitment, now: string): CommitmentView {
  const shownAt = commitment.timeSpec.dueAt ?? commitment.timeSpec.remindAt;
  const status = STATUS[commitment.status] ?? 'active';
  const shownMs = shownAt ? Date.parse(shownAt) : Number.NaN;
  const allDay = commitment.timeSpec.allDay === true;
  const isPast = status === 'active' && !Number.isNaN(shownMs) && (allDay
    ? dayHasEnded(shownMs, now, resolveTimeZone(commitment.timeSpec.timezone))
    : shownMs < Date.parse(now));
  const reasonCodes = commitment.reasonCodes ?? [];
  return {
    id: commitment.id,
    title: commitment.title,
    importance: IMPORTANCE[commitment.priority.level],
    status,
    shownAt,
    allDay,
    allDayEvent: allDay && commitment.timeSpec.kind === 'scheduled_event',
    postponedUntil: commitment.currentAckState === 'postponed' ? commitment.postponedUntil : null,
    isPast,
    importanceIsStated: commitment.priority.source === 'user_explicit',
    rank: commitment.rank,
    // An all-day item is late only once its day is over (`isPast`): the
    // server read its midnight as the deadline and called the appointment late
    // at 10:05 on its own day (final UAT, N18).
    reasonCodes: allDay && !isPast ? reasonCodes.filter((code) => code !== 'overdue') : reasonCodes,
  };
}

/**
 * An all-day commitment's instant is its day's local midnight, which nobody
 * chose: it is today's until that day ends, in the zone the day was named in
 * (FY1 review M2), the same rule `nextUsefulItem` judges it by.
 */
function dayHasEnded(dayStartMs: number, now: string, timeZone: string): boolean {
  return dayKey(new Date(dayStartMs), timeZone) < dayKey(new Date(now), timeZone);
}

export interface TodayGroups {
  must: CommitmentView[];
  should: CommitmentView[];
  nice: CommitmentView[];
  /** Done and dropped together: both are finished, and both collapse. */
  finished: CommitmentView[];
}

/**
 * Today, in the three groups the design draws plus the collapsed one.
 *
 * ── Ranking orders *within* a group, never across ────────────────
 *
 * UC-2.8 (#169) returns a whole-list rank, and the temptation is to sort the
 * screen by it. The design's groups are not decoration: Must, Should and Nice
 * are the user's own answer to "how much does this matter", and re-sorting
 * across them would let a rank put a Nice above a Must. So the rank orders
 * items inside each group and nothing else.
 *
 * With no rank — the priority module off — items keep the time order the
 * server sent, which is exactly what the screen did before ranking existed.
 */
export function groupForToday(commitments: readonly Commitment[], now: string): TodayGroups {
  const groups: TodayGroups = { must: [], should: [], nice: [], finished: [] };

  for (const commitment of commitments) {
    const view = toViewModel(commitment, now);
    if (view.status !== 'active') groups.finished.push(view);
    else groups[view.importance].push(view);
  }

  for (const key of ['must', 'should', 'nice'] as const) {
    groups[key] = sortWithinGroup(groups[key]);
  }
  // Finished items are ordered by when they were shown, newest last, so the
  // collapsed section reads as the day happened rather than as a ranking.
  groups.finished.sort((a, b) => instantOf(a) - instantOf(b));

  return groups;
}

function instantOf(view: CommitmentView): number {
  return view.shownAt ? Date.parse(view.shownAt) : Number.POSITIVE_INFINITY;
}

function sortWithinGroup(views: CommitmentView[]): CommitmentView[] {
  const ranked = views.every((view) => view.rank !== undefined);
  return [...views].sort((a, b) => (
    ranked ? a.rank! - b.rank! : instantOf(a) - instantOf(b)
  ) || compareIds(a.id, b.id));
}

/** Code points, never `localeCompare`: the order must not shift with the host locale. */
function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * The one item that gets a "why first" line (UC-2.8, #169).
 *
 * The first open card in the first non-empty group, and only if it has
 * something to say. Every card explaining itself is no explanation at all —
 * and an item whose reason is "it is simply next" has no line rather than a
 * filler one.
 */
export function topItemFor(groups: TodayGroups): CommitmentView | null {
  for (const key of ['must', 'should', 'nice'] as const) {
    const first = groups[key][0];
    if (first) return first.reasonCodes.length > 0 ? first : null;
  }
  return null;
}

/** One calendar day of the future, with what is on it. */
export interface UpcomingDay {
  /** "2026-09-14" in the user's timezone. Compared, never displayed. */
  key: string;
  /**
   * An instant that falls on that local day, for the header to format.
   *
   * The first item's own time, deliberately, rather than a synthesised midday:
   * midday UTC lands on the following local day anywhere past +12, so
   * Kiritimati would read every heading off by one.
   */
  at: string;
  items: CommitmentView[];
}

/**
 * The days ahead (UC-2.R3, #173).
 *
 * ── Days, from the timezone the app told the server about ────────
 *
 * The grouping is by calendar day in the user's zone, using the same `dayKey`
 * the relative-day copy uses, because the server bounded `upcoming` the same
 * way: "a later local day than today". Grouping by elapsed hours instead would
 * put 23:30 tonight and 00:30 tomorrow on one heap.
 *
 * ── A calendar is chronological, even when a ranker disagrees ────
 *
 * #169's rank answers "what should I do next", which is a question about now.
 * Thursday is not now. Sorting Thursday by importance would tell the user their
 * 09:00 is after their 17:00, so the day reads by the clock and the rank is
 * only a tiebreak between two things at the same minute.
 *
 * Undated items never appear: `listUpcomingRanked` excludes them because an
 * item with no time has no later day to be on, and it stays on Today.
 */
export function groupUpcoming(
  commitments: readonly Commitment[],
  now: string,
  timeZone: string,
): UpcomingDay[] {
  const byDay = new Map<string, CommitmentView[]>();

  for (const commitment of commitments) {
    const view = toViewModel(commitment, now);
    // Defensive: the route already filters these out. A finished item holding a
    // slot on a future day would read as something still to do.
    if (view.status !== 'active' || !view.shownAt) continue;
    const key = dayKey(new Date(view.shownAt), timeZone);
    const day = byDay.get(key);
    if (day) day.push(view);
    else byDay.set(key, [view]);
  }

  return Array.from(byDay.entries())
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, items]) => {
      const sorted = items.sort((a, b) => (
        instantOf(a) - instantOf(b)
        || (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY)
        || compareIds(a.id, b.id)
      ));
      return { key, at: sorted[0]!.shownAt!, items: sorted };
    });
}

/**
 * The clock a row shows for a commitment, or `null` when there is none to show:
 * no time at all, or an all-day one whose midnight is not an hour (FX3). Every
 * screen that prints a commitment's time asks this, so «00:00» cannot come back
 * through one that forgot.
 */
export function clockOf(view: Pick<CommitmentView, 'shownAt' | 'allDay'>, options: FormatOptions): string | null {
  if (!view.shownAt || view.allDay) return null;
  return ltr(formatTime(new Date(view.shownAt), options));
}

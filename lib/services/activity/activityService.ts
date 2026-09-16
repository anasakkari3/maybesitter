/**
 * What the two activity routes actually do (UC-3.15, #201).
 *
 * The routes stay as thin as their neighbours: auth, read the query string,
 * call one of these, answer. Everything that decides what a person is shown is
 * here and in the two pure modules beside it, so it can be tested without a
 * Request.
 */
import { COMMITMENTS, PLAN_EVENTS, getStorage, requireUserId, userCol, userDoc } from '../../storage';
import type { Commitment } from '../../../src/domain/stateMachine';
import type { UserDocument } from '../../storage/userDocument';
import type { PlanEvent } from '../dailyPlan/planStore';
import {
  compareEventsNewestFirst,
  cursorFor,
  listEvents,
  listEventsInRange,
  MAX_EVENT_PAGE,
  type DomainEventRecord,
  type EventPage,
} from '../mobile/eventLog';
import { normalizeTimezone } from '../mobile/time';
import { projectActivity, type ActivityItem } from './activityProjection';
import { readActivityStats } from './activityStats';
import { ACTIVITY_KIND_BY_PLAN_EVENT_TYPE, earliestLedgerAcceptance, planEventAsRecord } from './planActivity';
export { LEGACY_PLAN_SCAN } from './planActivity';
import {
  currentWeekStart,
  isWeekStartKey,
  summariseWeek,
  weekWindow,
  type WeeklySummary,
} from './weeklySummary';

/** #201: at most 500 events are read to build one week's summary. */
export const SUMMARY_EVENT_LIMIT = 500;
export const DEFAULT_ACTIVITY_PAGE = 20;

export interface ActivityPage {
  items: ActivityItem[];
  nextCursor: string | null;
}

async function commitmentsById(uid: string): Promise<Map<string, Commitment>> {
  const rows = await getStorage().list<Commitment>(userCol(uid, COMMITMENTS));
  return new Map(rows.map((row) => [row.data.id, row.data]));
}

/** A ledger row planActivity allows to become activity. */
function shownOnLedger(row: DomainEventRecord): boolean {
  return ACTIVITY_KIND_BY_PLAN_EVENT_TYPE[row.type] !== undefined;
}

/** Only the ledger entries planActivity allows, shaped as records. */
function shownPlanRecords(rows: readonly DomainEventRecord[]): DomainEventRecord[] {
  return rows.filter(shownOnLedger).map((row) => planEventAsRecord(row as unknown as PlanEvent));
}

/**
 * One page of the domain log and the plan ledger together, newest first.
 *
 * Each collection is paged from the same cursor for the same `limit`, so each
 * page holds that collection's first `limit` records after the cursor — and
 * the first `limit` of the union are therefore all in the union of the two.
 * Both use the one total order (`at` descending, stored id ascending), so the
 * cursor this returns names a record wherever it lives, and the next page of
 * *either* collection starts strictly after it. More remains when the merge
 * had records left over or either collection said it had more.
 *
 * The page is cut, and the cursor placed, over *every* ledger row, and only
 * then are the rows planActivity does not allow removed. Filtering first would
 * let a run of rebuilt or dismissed plans empty a page while older acceptances
 * still waited behind it — a page with no last record has nowhere to put a
 * cursor, and the walk would end there. So a page may come back shorter than
 * `limit`, or empty, with a cursor; `listActivity` reads on through it.
 *
 * A ledger row keeps nothing but its allowlisted kind: one named like a
 * domain event (`commitment_completed`) is still not a completion, because it
 * is judged by the ledger's allowlist, never the domain log's.
 */
export async function listActivitySources(
  uid: string,
  options: { limit: number; cursor: string | null },
): Promise<EventPage> {
  const [domain, plans] = await Promise.all([
    listEvents(uid, { limit: options.limit, cursor: options.cursor }),
    listEvents(uid, { limit: options.limit, cursor: options.cursor, collection: PLAN_EVENTS }),
  ]);
  const ledger = new Set(plans.events);
  const merged = [...domain.events, ...plans.events].sort(compareEventsNewestFirst);
  const page = merged.slice(0, options.limit);
  const more = merged.length > options.limit || domain.nextCursor !== null || plans.nextCursor !== null;
  const last = page[page.length - 1];
  return {
    events: page.flatMap((event) => {
      if (!ledger.has(event)) return [event];
      return shownOnLedger(event) ? [planEventAsRecord(event as unknown as PlanEvent)] : [];
    }),
    nextCursor: more && last ? cursorFor(last) : null,
  };
}

/**
 * One page of history, newest first.
 *
 * The log is read in event pages and projected as it goes, because most events
 * are not user-facing: a window of twenty events holding eight internal ones
 * would answer twelve items and read as the end of the history. It reads on
 * until it has a full page of entries or the log runs out.
 *
 * The cursor it returns names the last **event** the page consumed, not the
 * last item it produced. Stopping at the item would re-read, and re-show,
 * every event between that item and the end of the window.
 */
export async function listActivity(input: {
  uid: string;
  cursor?: string | null | undefined;
  limit?: number | undefined;
}): Promise<ActivityPage> {
  const uid = requireUserId(input.uid);
  const limit = clampPageSize(input.limit);
  const titles = await commitmentsById(uid);

  const items: ActivityItem[] = [];
  let cursor = input.cursor ?? null;
  let stoppedAt: string | null = null;

  // Bounded: an account whose log is all internal events must not turn one
  // request into an unbounded walk of its whole history. Ten windows of fifty
  // is five hundred events, the same ceiling the summary reads.
  for (let round = 0; round < 10 && stoppedAt === null; round += 1) {
    const page = await listActivitySources(uid, { limit: MAX_EVENT_PAGE, cursor });
    for (const event of page.events) {
      for (const item of projectActivity([event], titles)) items.push(item);
      if (items.length >= limit) {
        stoppedAt = cursorFor(event);
        break;
      }
    }
    if (stoppedAt === null) {
      cursor = page.nextCursor;
      if (cursor === null) break;
    }
  }

  return { items: items.slice(0, limit), nextCursor: stoppedAt ?? cursor };
}

export interface WeeklySummaryInput {
  uid: string;
  weekStart?: string | null | undefined;
  now?: Date;
}

/**
 * The week's summary, defaulting to the current local week.
 *
 * The zone and the first day of the week come from `users/{uid}` — the
 * timezone the routine profile saved and the locale the account is in — rather
 * than from the client, so two devices in different zones do not disagree
 * about which week it is.
 */
export async function weeklySummaryFor(input: WeeklySummaryInput): Promise<WeeklySummary> {
  const uid = requireUserId(input.uid);
  const now = input.now ?? new Date();
  const storage = getStorage();
  const user = await storage.get<UserDocument>(userDoc(uid));
  const timezone = normalizeTimezone(user?.timezone);
  const locale = user?.locale ?? null;

  const weekStart = isWeekStartKey(input.weekStart)
    ? input.weekStart
    : currentWeekStart(now, timezone, locale);
  const window = weekWindow(weekStart, timezone);

  const [events, planRows, titles, counted] = await Promise.all([
    listEventsInRange(uid, window.fromInclusive, window.toExclusive, SUMMARY_EVENT_LIMIT),
    listEventsInRange(uid, window.fromInclusive, window.toExclusive, SUMMARY_EVENT_LIMIT, storage, PLAN_EVENTS),
    commitmentsById(uid),
    readActivityStats(storage, uid),
  ]);
  // Only an account whose counter has never seen an acceptance can have one
  // the counter does not know about: the first real acceptance folds any
  // legacy one in (see `acceptPlan`), so once it is set the scan is skipped.
  const earliestPlan = counted.firstPlanAcceptedAt === null
    ? await earliestLedgerAcceptance(storage, uid)
    : null;
  const stats = {
    ...counted,
    firstPlanAcceptedAt: earliestOf(counted.firstPlanAcceptedAt, earliestPlan),
  };

  return summariseWeek({
    window,
    timezone,
    events: [...events, ...shownPlanRecords(planRows)],
    commitmentsById: titles,
    stats,
  });
}

function earliestOf(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return right < left ? right : left;
}

function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_ACTIVITY_PAGE;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_EVENT_PAGE);
}

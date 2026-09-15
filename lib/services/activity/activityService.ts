/**
 * What the two activity routes actually do (UC-3.15, #201).
 *
 * The routes stay as thin as their neighbours: auth, read the query string,
 * call one of these, answer. Everything that decides what a person is shown is
 * here and in the two pure modules beside it, so it can be tested without a
 * Request.
 */
import { COMMITMENTS, getStorage, requireUserId, userCol, userDoc } from '../../storage';
import type { Commitment } from '../../../src/domain/stateMachine';
import type { UserDocument } from '../../storage/userDocument';
import { cursorFor, listEvents, listEventsInRange, MAX_EVENT_PAGE } from '../mobile/eventLog';
import { normalizeTimezone } from '../mobile/time';
import { projectActivity, type ActivityItem } from './activityProjection';
import { readActivityStats } from './activityStats';
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
    const page = await listEvents(uid, { limit: MAX_EVENT_PAGE, cursor });
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

  const [events, titles, stats] = await Promise.all([
    listEventsInRange(uid, window.fromInclusive, window.toExclusive, SUMMARY_EVENT_LIMIT),
    commitmentsById(uid),
    readActivityStats(storage, uid),
  ]);

  return summariseWeek({ window, timezone, events, commitmentsById: titles, stats });
}

function clampPageSize(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_ACTIVITY_PAGE;
  return Math.min(Math.max(Math.trunc(raw), 1), MAX_EVENT_PAGE);
}

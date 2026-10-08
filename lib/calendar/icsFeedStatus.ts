import type { CalendarSource } from './busyBlocks';
import type { IcsFeedDocument } from './icsFeeds';

const HOUR_MS = 3_600_000;
export const ICS_FEED_STALE_MS = 26 * HOUR_MS;

export type IcsFeedReadStatus = 'ok' | 'paused' | 'error' | 'stale' | 'uninitialized';

/** One readiness rule for every server-side consumer of an ICS busy window. */
export function icsFeedReadStatus(
  feed: Pick<IcsFeedDocument, 'status' | 'lastFetchedAt'>,
  source: CalendarSource | null | undefined,
  now: Date | number = Date.now(),
): IcsFeedReadStatus {
  if (!source) return 'uninitialized';
  if (feed.status === 'paused') return 'paused';
  if (feed.status === 'error') return 'error';
  const lastFetchedAt = feed.lastFetchedAt ? Date.parse(feed.lastFetchedAt) : Number.NaN;
  if (!Number.isFinite(lastFetchedAt)) return 'uninitialized';
  const nowMs = typeof now === 'number' ? now : now.getTime();
  return nowMs - lastFetchedAt > ICS_FEED_STALE_MS ? 'stale' : 'ok';
}

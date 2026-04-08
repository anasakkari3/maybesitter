import { buildCalendarFeed } from '../../../../lib/services/calendarFeedService';
import { getUnifiedAppSnapshot } from '../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

export async function GET() {
  const feed = buildCalendarFeed(await getUnifiedAppSnapshot());

  return new Response(feed, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="maybesitter.ics"',
      'Cache-Control': 'no-store',
    },
  });
}

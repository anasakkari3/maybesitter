import { handleIcsRefreshTick } from '../../../../../../../lib/calendar/icsFeedRoutes';

export const dynamic = 'force-dynamic';

/** Called by Cloud Scheduler every 30 minutes; see lib/calendar/icsFeedRoutes and infra/scheduler.sh. */
export async function POST(request: Request) {
  return handleIcsRefreshTick(request);
}

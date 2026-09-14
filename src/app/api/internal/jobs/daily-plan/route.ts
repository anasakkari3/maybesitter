import { handleDailyPlanRequest } from '../../../../../../lib/jobs/internalJobs';

export const dynamic = 'force-dynamic';

/** Called by Cloud Scheduler every minute; see lib/jobs/internalJobs and infra/scheduler.sh. */
export async function POST(request: Request) {
  return handleDailyPlanRequest(request);
}

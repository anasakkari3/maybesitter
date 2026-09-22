import { handleContinuousReplanRequest } from '../../../../../../lib/jobs/internalJobs';

export const dynamic = 'force-dynamic';

/**
 * Called by Cloud Scheduler or internal triggers; see lib/jobs/internalJobs and
 * lib/services/dailyPlan/continuousReplanService.
 *
 * Processes accounts that have pending planning state changes and applies continuous
 * replanning according to the user's control policy.
 */
export async function POST(request: Request) {
  return handleContinuousReplanRequest(request);
}

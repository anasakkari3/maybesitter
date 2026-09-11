import { handleMaintenanceRequest } from '../../../../../../lib/jobs/internalJobs';

export const dynamic = 'force-dynamic';

/** Called by Cloud Scheduler nightly; see lib/jobs/internalJobs and infra/scheduler.sh. */
export async function POST(request: Request) {
  return handleMaintenanceRequest(request);
}

import { handleWatcherSweepRequest } from '../../../../../../lib/jobs/internalJobs';

export const dynamic = 'force-dynamic';

/**
 * Called by Cloud Scheduler every minute; see lib/jobs/internalJobs and
 * infra/scheduler.sh.
 *
 * The sweep is bounded (`WATCHER_SWEEP_BATCH`) rather than time-budgeted: one
 * run touches a known number of watchers and reports `remaining` when there
 * were more, which the next minute's tick takes. That is the same answer the
 * reminder tick gives a backlog, and it keeps the call well inside the 60s
 * attempt deadline `infra/scheduler.sh` sets for every internal job route.
 */
export async function POST(request: Request) {
  return handleWatcherSweepRequest(request);
}

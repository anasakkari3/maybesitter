import { handleFootballSyncRequest } from '../../../../../../lib/jobs/internalJobs';

export const dynamic = 'force-dynamic';

/**
 * Called by Cloud Scheduler once nightly; see lib/jobs/internalJobs and
 * infra/scheduler.sh.
 *
 * ── The deadline and the sync's budget must agree ──────────────────────────
 * `infra/scheduler.sh`'s `upsert_job` sets `--attempt-deadline=60s` for every
 * internal job route, this one included. `runFootballSyncJob` (via
 * `syncFollowedClubs`) budgets itself to `DEFAULT_SYNC_BUDGET_MS = 45_000`
 * for exactly this deadline -- stopping well inside 60s rather than being cut
 * off by it. The two numbers are independent constants in independent files;
 * nothing enforces that 45s stays under 60s except a human reading both
 * comments before changing either one. If `infra/scheduler.sh` ever lowers
 * this route's deadline below the sync's budget, or the budget is raised
 * without checking the deadline, the budget stops doing the job it was built
 * for -- see `lib/football/syncFixtures.ts`'s own header for why that job
 * matters.
 *
 * ── What a retry-driven overlap still costs ─────────────────────────────
 * The 60s deadline (and Cloud Scheduler's default retry on top of it) is
 * exactly what can still make two invocations of this route run
 * concurrently -- the budget above shrinks how often that happens, it does
 * not prevent it. What an overlapping pair of runs costs is documented once,
 * in `lib/football/fixtureStore.ts`'s module header ("Why there is no
 * transaction here"); it is not restated here.
 */
export async function POST(request: Request) {
  return handleFootballSyncRequest(request);
}

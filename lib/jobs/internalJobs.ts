/**
 * The work behind `/api/internal/jobs/*` (UC-1.0d, #143).
 *
 * Cloud Scheduler calls these routes: a tick every minute, maintenance once a
 * night. Everything here is a plain function with injectable dependencies so
 * the routes stay one line and the behaviour is testable without a server.
 *
 * ── Whose state a job changes ────────────────────────────────────
 *
 * A job carries its owner's `uid`, and its command is applied to that user's
 * durable `users/{uid}` state through `applyParticipantCommand`, inside a
 * transaction. It is *not* applied through `commandService`: since UC-1.0c
 * (#142) that module holds a per-process state for the legacy web routes, so on
 * Cloud Run it is empty, and every reminder would fail as "missing entity".
 *
 * For the same reason the tick constructs its own scheduler store and awaits
 * `runDueJobs`, and never hands a store to `configureCommandService`, which
 * would make `applyCommand` create jobs fire-and-forget.
 */
import { resumeStalledDeletions } from '../account/accountDeletion';
import { runDailyPlanTick, type DailyPlanTickTotals } from '../services/dailyPlan/dailyPlanService';
import { applyParticipantCommand } from '../services/mobile/participantState';
import { ValidationError } from '../../src/domain/stateMachine';
import { runDueJobs, type CommandHandler, type SchedulerStore } from '../../src/scheduler/jobRunner';
import { createStorageSchedulerStore } from '../scheduler/storageSchedulerStore';
import { createStorageRuntimeMemoryStore } from '../runtimeMemory/runtimeMemoryStore';
import { createStorageAlphaFeedbackStore } from '../alphaFeedback/alphaFeedbackStore';
import { createStorageAlphaTraceStore } from '../alphaTrace/alphaTraceStore';
import { StorageClarificationStore } from '../services/clarificationStore';
import type { StorageAdapter } from '../storage/storageAdapter';
import {
  authorizeSchedulerRequest,
  schedulerAuthErrorResponse,
  type HeaderBearing,
  type OidcVerify,
} from '../auth/schedulerOidc';
import { createFootballDataProvider } from '../football/footballDataProvider';
import { listFollowedUserIds } from '../football/followedClubs';
import { projectFixturesForUser } from '../football/projectFixtures';
import { syncFollowedClubs, type SyncReport } from '../football/syncFixtures';
import type { FixtureProvider } from '../../src/contracts/v1/fixtureContracts';

/** `runDueJobs` claims this many per round; a full round means more may be due. */
export const TICK_BATCH = 25;
/** Cloud Scheduler's attempt deadline is 60 s; stop claiming well before it. */
export const TICK_BUDGET_MS = 45_000;

/**
 * Applies a job's command to its owner's durable state.
 *
 * A job with no owner is refused as a `ValidationError`, which `runDueJobs`
 * records as a failure without retrying: there is nobody whose state it could
 * change, and retrying would not make one appear. `applyParticipantCommand`
 * already turns a missing reminder or an invalid transition into
 * `rejected`/`noop` rather than throwing.
 */
export const participantJobHandler: CommandHandler = async (command, job) => {
  if (!job.uid) {
    throw new ValidationError(`job ${job.id} has no owner, so its command cannot be applied to anyone's state`);
  }
  const { result: outcome, ...rest } = await applyParticipantCommand(job.uid, command);
  // `invalid_transition` is a separate answer for the mobile API, which needs to
  // tell a user that completing an already-completed commitment did nothing
  // (#148). For a scheduled job it is the same thing it always was: the command
  // no longer applies, nothing changed, and retrying cannot help — a no-op.
  return { ...rest, result: outcome === 'invalid_transition' ? 'noop' : outcome };
};

export interface TickTotals {
  claimed: number;
  completed: number;
  noOp: number;
  failed: number;
  rounds: number;
  /** `drained`: a round claimed fewer than a full batch. `budget`: time ran out first. */
  stoppedBy: 'drained' | 'budget';
}

export interface TickOptions {
  store?: SchedulerStore;
  handleCommand?: CommandHandler;
  clock?: () => number;
  budgetMs?: number;
}

/**
 * Runs due jobs until the queue is drained or the time budget is spent.
 *
 * One `runDueJobs` round claims at most 25, so a backlog — after an outage, or
 * a burst of reminders due in the same minute — needs several rounds. The
 * budget keeps the call inside Scheduler's deadline; whatever is left is
 * claimed by the next tick a minute later. Claims are transactional, so two
 * overlapping ticks (Scheduler retries) cannot run the same job twice.
 */
export async function runJobsTick(options: TickOptions = {}): Promise<TickTotals> {
  const store = options.store ?? createStorageSchedulerStore();
  const handle = options.handleCommand ?? participantJobHandler;
  const clock = options.clock ?? Date.now;
  const budget = options.budgetMs ?? TICK_BUDGET_MS;
  const started = clock();
  const totals: TickTotals = { claimed: 0, completed: 0, noOp: 0, failed: 0, rounds: 0, stoppedBy: 'drained' };

  for (;;) {
    const round = await runDueJobs(store, handle, new Date(clock()));
    totals.rounds += 1;
    totals.claimed += round.claimed;
    totals.completed += round.completed;
    totals.noOp += round.noOp;
    totals.failed += round.failed;
    if (round.claimed < TICK_BATCH) return totals;
    if (clock() - started >= budget) {
      totals.stoppedBy = 'budget';
      return totals;
    }
  }
}

export interface MaintenanceStep {
  name: string;
  ok: boolean;
  count?: number;
}

export interface MaintenanceOptions {
  storage?: StorageAdapter;
  now?: Date;
}

/**
 * The nightly retention sweep.
 *
 * Runtime memory and alpha feedback have no Firestore TTL at all, so this is
 * the only thing that ever ages them out. Alpha traces and clarifications do
 * have a TTL policy (infra/firestore-ttl.sh), but TTL deletion is eventual —
 * up to a day late — so they are swept here too.
 *
 * Each step runs whatever the others do: one store being unreachable must not
 * leave the other three unswept. Any failure makes the whole call fail, so
 * Cloud Scheduler records it and retries.
 *
 * UC-1.5 (#149) adds resuming interrupted account deletions here. It is not in
 * this list because it does not exist yet; an entry that did nothing would
 * report a sweep that never happened.
 */
export async function runMaintenance(options: MaintenanceOptions = {}): Promise<{ ok: boolean; steps: MaintenanceStep[] }> {
  const now = options.now ?? new Date();
  const storage = options.storage;
  const withStorage = storage ? { storage } : {};

  const steps: Array<[string, () => Promise<number | void>]> = [
    ['runtime_memory_expired', () => createStorageRuntimeMemoryStore(undefined, storage).prune(now.toISOString())],
    ['alpha_feedback_pruned', () => createStorageAlphaFeedbackStore(withStorage).prune()],
    ['alpha_traces_pruned', () => createStorageAlphaTraceStore(withStorage).prune()],
    ['clarifications_pruned', () => new StorageClarificationStore(storage).pruneExpired(now)],
    // A deletion whose instance went away must still finish. It is last because
    // it is the only step that can fail for a reason outside this service
    // (#149).
    ['deletions_resumed', async () => (await resumeStalledDeletions({ now, ...withStorage })).resumed],
  ];

  const results: MaintenanceStep[] = [];
  for (const [name, run] of steps) {
    try {
      const count = await run();
      results.push(typeof count === 'number' ? { name, ok: true, count } : { name, ok: true });
    } catch (error) {
      console.error(`[internal/jobs/maintenance] ${name} failed`, error);
      results.push({ name, ok: false });
    }
  }
  return { ok: results.every((step) => step.ok), steps: results };
}

/** What one user's followed fixtures became, summed across every followed user (football fixtures MVP, Task 9). */
export interface FootballProjectionSummary {
  /** Users actually projected (i.e. following at least one club) -- see `listFollowedUserIds`. */
  users: number;
  created: number;
  updated: number;
  cancelled: number;
  skipped: number;
  completed: number;
  /** One user's projection failing (a malformed ref, a transient storage error) is recorded here, not thrown -- see `runFootballSyncJob`'s own comment for why. */
  failures: Array<{ uid: string; reason: string }>;
}

/** `enabled: false` (no `sync`/`projection` at all) means the feature is off for this install -- see `runFootballSyncJob`. */
export interface FootballSyncJobReport {
  enabled: boolean;
  sync?: SyncReport;
  projection?: FootballProjectionSummary;
}

export interface FootballSyncJobOptions {
  /**
   * Defaults to `process.env`, read here (not inside
   * `createFootballDataProvider`) so the "no key" decision belongs to the
   * job, before any provider is even built.
   *
   * Typed as the one key this job actually reads, not the full
   * `NodeJS.ProcessEnv` -- see `FootballDataProviderDeps.env`'s own comment
   * in `footballDataProvider.ts` for why: this project's Next.js type
   * augmentation makes `NODE_ENV` a required property of `ProcessEnv`, which
   * would force every test constructing an "explicitly empty environment" to
   * supply a `NODE_ENV` this job never looks at.
   */
  env?: { FOOTBALL_DATA_API_KEY?: string };
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
  budgetMs?: number;
  storage?: StorageAdapter;
  /** Test seam: bypasses the real football-data.org provider entirely. */
  provider?: FixtureProvider;
}

/**
 * The nightly job that turns followed clubs' fixtures into commitments
 * (football fixtures MVP, Task 9).
 *
 * ── A missing key reports the feature off, and never throws ───────────────
 * `createFootballDataProvider`'s own `listFixtures` throws when it is asked
 * to fetch without a key -- correct for a caller mid-sync, who has fixtures
 * it is trying to fetch right now. This job's question is different: should
 * a sync even be attempted tonight? An install that never set
 * `FOOTBALL_DATA_API_KEY` never turned football on, and Cloud Scheduler
 * treats a thrown 5xx as "retry me" -- there is nothing a retry would fix
 * here, and nothing worth a stack trace in the log every night forever. So
 * the key is checked here, before any provider is constructed, and a missing
 * one returns `{ enabled: false }` rather than reaching the provider at all.
 *
 * ── This is `projectFixturesForUser`'s first real caller ──────────────────
 * `syncFollowedClubs` only fetches and stores fixtures; turning a stored
 * fixture into a commitment is `projectFixturesForUser`'s job
 * (`projectFixtures.ts`). Wiring the two together here is what the Task 8
 * report's "Fix round 3" section calls out by name: `projectFixturesForUser`
 * reads a fixture's ref once at the top of `projectOneFixture`, so it can
 * race a concurrent `dismissFixtureCommitment` (a user tapping "not this
 * match") and miss a dismissal that lands in the gap between that read and
 * this run's write. That race was left unfixed while neither function had a
 * caller, which made it theoretical. It stops being theoretical the moment
 * this loop runs against real users' data -- a nightly job and a tap are not
 * equally likely to collide (a fixed, small nightly window against however
 * many taps a day actually happens is a low-probability overlap, not a
 * common one, and this job does not change the shape of the race, only gives
 * it its first live occasion), but "unlikely" is not "impossible", and this
 * task does not fix it. What this loop does do is avoid *widening* it: users
 * are projected one at a time, sequentially, never with `Promise.all` --
 * concurrent projection runs are not needed for anything this job requires,
 * and introducing them would only add more ways for two writers to overlap
 * than the one race already on record.
 *
 * ── One user's projection failing does not stop the rest ──────────────────
 * The same isolation `syncFollowedClubs` gives the fetch side (one club's
 * failure is recorded and the rest continue) is given to the projection
 * side here: a malformed ref or a transient storage error for one uid is
 * caught, recorded in `projection.failures`, and every other followed
 * user's fixtures still get projected.
 *
 * ── What is NOT budgeted here ──────────────────────────────────────────────
 * `syncFollowedClubs` is time-budgeted (see that module's header) because its
 * unbudgeted shape was measured against the scheduler's deadline and found to
 * overrun it. The projection loop below is not separately budgeted -- Task 9
 * was not asked to build a second resumability mechanism, and the followed
 * population is small by the MVP's own design (a curated list of fifteen
 * clubs). If the followed-user count grows enough that this loop threatens
 * the same 60-second deadline the fetch loop was budgeted against, it needs
 * the identical treatment `syncFollowedClubs` already models: a budget, and a
 * per-user "last projected" cursor so a user who sorts last is not starved
 * the way a club almost was. Recorded here rather than fixed here, since
 * nothing today demonstrates the deadline is actually at risk.
 */
export async function runFootballSyncJob(options: FootballSyncJobOptions = {}): Promise<FootballSyncJobReport> {
  // The object itself defaults to `process.env`, not the individual field --
  // `options.env ?? process.env`, not `options.env?.FOOTBALL_DATA_API_KEY ??
  // process.env.FOOTBALL_DATA_API_KEY`. The latter would let an *explicitly*
  // empty test environment (`{ env: {} }`, meaning "no key, on purpose")
  // silently fall back to whatever happens to be exported in the real shell
  // running the test -- the exact ambient-environment defect Task 3's own
  // report flagged once already (`footballDataProvider.ts`'s own `env =
  // deps.env ?? process.env` comment explains the same choice for the same
  // reason). A property *read* off the result is fine wherever it happens;
  // it is only re-assigning the whole object into another weakly-typed `env`
  // parameter downstream that the interface's narrower type exists to avoid
  // -- see `FootballSyncJobOptions.env`'s own comment.
  const env = options.env ?? process.env;
  if (!options.provider && !env.FOOTBALL_DATA_API_KEY) {
    return { enabled: false };
  }

  const now = (options.now ?? new Date()).toISOString();
  const provider = options.provider ?? createFootballDataProvider(options.env ? { env: options.env } : {});

  const sync = await syncFollowedClubs({
    provider,
    now,
    sleep: options.sleep,
    clock: options.clock,
    budgetMs: options.budgetMs,
    storage: options.storage,
  });

  const projection: FootballProjectionSummary = {
    users: 0, created: 0, updated: 0, cancelled: 0, skipped: 0, completed: 0, failures: [],
  };
  const uids = await listFollowedUserIds({ storage: options.storage });
  for (const uid of uids) {
    try {
      const tally = await projectFixturesForUser(uid, now);
      projection.users += 1;
      projection.created += tally.created;
      projection.updated += tally.updated;
      projection.cancelled += tally.cancelled;
      projection.skipped += tally.skipped;
      projection.completed += tally.completed;
    } catch (error) {
      projection.failures.push({ uid, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { enabled: true, sync, projection };
}

export interface InternalJobsDeps {
  env?: NodeJS.ProcessEnv;
  verify?: OidcVerify;
  tick?: () => Promise<TickTotals>;
  maintenance?: () => Promise<{ ok: boolean; steps: MaintenanceStep[] }>;
  dailyPlan?: () => Promise<DailyPlanTickTotals>;
  footballSync?: () => Promise<FootballSyncJobReport>;
}

function authOptions(deps: InternalJobsDeps): { env?: NodeJS.ProcessEnv; verify?: OidcVerify } {
  return { ...(deps.env ? { env: deps.env } : {}), ...(deps.verify ? { verify: deps.verify } : {}) };
}

/** `POST /api/internal/jobs/run`. */
export async function handleJobsRunRequest(request: HeaderBearing, deps: InternalJobsDeps = {}): Promise<Response> {
  const auth = await authorizeSchedulerRequest(request, authOptions(deps));
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  try {
    return Response.json(await (deps.tick ?? runJobsTick)());
  } catch (error) {
    // A 5xx makes Cloud Scheduler retry; the detail goes to the log only.
    console.error('[internal/jobs/run] tick failed', error);
    return Response.json({ error: 'job_run_failed' }, { status: 500 });
  }
}

/**
 * `POST /api/internal/jobs/daily-plan` (UC-3.10a, #194).
 *
 * Its own route rather than a step inside `runJobsTick`, and the separation is
 * the point. `/jobs/run` answers 5xx so that Cloud Scheduler retries the
 * *reminder* queue; folding plan building into it would mean one account's
 * unreadable profile made every user's due reminders run twice. The two crons
 * fail independently because they are two crons.
 *
 * The guard is the same `authorizeSchedulerRequest` — the same audience, the
 * same service account, the same "every refusal looks identical" 401. There is
 * deliberately no second OIDC implementation for this endpoint.
 */
export async function handleDailyPlanRequest(request: HeaderBearing, deps: InternalJobsDeps = {}): Promise<Response> {
  const auth = await authorizeSchedulerRequest(request, authOptions(deps));
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  try {
    return Response.json(await (deps.dailyPlan ?? runDailyPlanTick)());
  } catch (error) {
    console.error('[internal/jobs/daily-plan] sweep failed', error);
    return Response.json({ error: 'daily_plan_failed' }, { status: 500 });
  }
}

/** `POST /api/internal/jobs/maintenance`. */
export async function handleMaintenanceRequest(request: HeaderBearing, deps: InternalJobsDeps = {}): Promise<Response> {
  const auth = await authorizeSchedulerRequest(request, authOptions(deps));
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  try {
    const result = await (deps.maintenance ?? runMaintenance)();
    return Response.json(result, { status: result.ok ? 200 : 500 });
  } catch (error) {
    console.error('[internal/jobs/maintenance] sweep failed', error);
    return Response.json({ error: 'maintenance_failed' }, { status: 500 });
  }
}

/**
 * `POST /api/internal/jobs/football-sync` (football fixtures MVP, Task 9).
 *
 * Its own route, for the same reason `handleDailyPlanRequest` gives for
 * having one: this cron fails independently of the reminder tick and the
 * retention sweep, rather than one account's bad fixture data taking every
 * user's due reminders down with it. Same OIDC guard, same audience, same
 * "every refusal looks identical" 401 -- see `handleDailyPlanRequest`'s own
 * comment; there is deliberately no second implementation of the check.
 *
 * This module does not add the actual `src/app/api/internal/jobs/
 * football-sync/route.ts` file or a `infra/scheduler.sh` entry that calls
 * it -- Task 9's brief scoped this file's job to registering the handler,
 * not to standing up the route tree or wiring Cloud Scheduler. Until a
 * follow-up does both, this function is reachable from code (and from
 * tests) but not yet from the internet, so nothing runs nightly on its own
 * yet -- see the Task 9 report's "concerns" for this gap named explicitly.
 */
export async function handleFootballSyncRequest(request: HeaderBearing, deps: InternalJobsDeps = {}): Promise<Response> {
  const auth = await authorizeSchedulerRequest(request, authOptions(deps));
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  try {
    return Response.json(await (deps.footballSync ?? runFootballSyncJob)());
  } catch (error) {
    console.error('[internal/jobs/football-sync] sync failed', error);
    return Response.json({ error: 'football_sync_failed' }, { status: 500 });
  }
}

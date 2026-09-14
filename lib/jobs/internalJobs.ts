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

export interface InternalJobsDeps {
  env?: NodeJS.ProcessEnv;
  verify?: OidcVerify;
  tick?: () => Promise<TickTotals>;
  maintenance?: () => Promise<{ ok: boolean; steps: MaintenanceStep[] }>;
  dailyPlan?: () => Promise<DailyPlanTickTotals>;
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

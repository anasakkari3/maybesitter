/**
 * Building each account's day, once, on the morning it asked for (UC-3.10a, #194).
 *
 * ── One cron, every timezone, and why the due instant is written down ──
 *
 * Cloud Scheduler fires at an instant; "every morning" is a promise about a
 * clock face. The reconciliation is that each account carries the instant its
 * *next* morning falls on (`planSettings.nextRunAt`, computed by
 * `nextDeliveryAt`), so one minute-by-minute tick can ask "whose morning is it
 * now?" as a range read that normally returns nobody. A user in Auckland and a
 * user in Santiago are the same query.
 *
 * This is the issue's option (b) — the due time is decided a day ahead — with
 * the due time kept on the user document rather than in the `jobs` collection.
 * Both give per-user local delivery and an O(due) tick. The user document was
 * chosen because the alternative means adding a member to `JobType`, and every
 * branch of `runDueJobs` maps its job to a **domain `Command`** that
 * `applyParticipantCommand` applies to `DomainState`. A daily plan has no such
 * command and must not have one: it writes a proposal, never canonical state
 * (`PLANNING_PERSISTENCE_POLICY.originalCommitmentRemainsCanonical`). Inventing
 * a `Command` so the plan could ride the reminder queue would put planning
 * inside the domain reducer, which is the one thing this whole track is not
 * allowed to do.
 *
 * ── Idempotency, in two independent layers ───────────────────────
 *
 * 1. **The claim.** `claimDueDelivery` reads `planSettings` and advances
 *    `nextRunAt` in one transaction. The field it writes is the field it read,
 *    so two ticks racing over one account serialise: the loser's read set moved,
 *    it retries, sees `nextRunAt` already in the future, and claims nothing.
 *    This is the property `tests/scheduler/schedulerContention.test.ts` proves
 *    for job claiming, applied to one document instead of a collection.
 * 2. **The write.** `createIfAbsent` reads the plan document and writes it in
 *    one transaction, and reports whether *this* call created it. The push is
 *    sent only on `created: true`.
 *
 * Layer 1 alone would be enough for two concurrent ticks. Layer 2 is what
 * covers a claim that succeeded and then crashed before writing, a Cloud
 * Scheduler retry of a request whose response was lost, and any future caller
 * that builds a plan without claiming first. Two locks, because the failure
 * they guard against — a person woken twice — is the failure people turn
 * notifications off over.
 *
 * **What neither layer covered:** a crash *between* the plan write and the
 * push, a push that threw, and a push quiet hours suppressed. The claim had
 * advanced, the document existed, and nobody was told — `createIfAbsent` makes
 * a replay *safe* without making one *happen*. #431 closes all three with one
 * mechanism: the plan is created carrying a push-pending marker, and the same
 * sweep re-arms a push-only retry from it (`planPushRetry.ts`, whose header
 * has the exactly-once argument and the late-delivery cutoff).
 *
 * ── The account's clock, read at delivery rather than at the PUT ──
 *
 * `planSettings.timezone` is a snapshot of `users/{uid}.timezone` at the last
 * `savePlanSettings`. It is no longer what anything reads: `planSettingsOf`
 * prefers the account's current zone, so a user who moves has the plan's date,
 * the zone it is built in and every delivery instant after this one follow
 * them. The snapshot stays in the document as the record of what the standing
 * `nextRunAt` was computed under.
 *
 * ── Two seams, both closed ───────────────────────────────────────
 *
 * The push: `PlanPushSender` defaults to `planReadyPushSender`, which hands the
 * notice to UC-3.0b (#184)'s `sendToUser`. It defaulted to a no-op until #184
 * landed, and nothing switched it over when #184 did — the route calls
 * `runDailyPlanTick()` with no arguments, so production built plans and rang
 * nobody. `tests/dailyPlan/planReadyPush.test.ts` injects no sender, only the
 * FCM client, for that reason.
 *
 * The busy time: UC-3.2 (#186) supplies `storedBusyBlocks` below, so
 * the default reader is the real one and a plan is built against whatever the
 * account's connected calendars say. `tests/calendar/busyPlanning.test.ts`
 * injects nothing, which is what makes that a claim about production rather
 * than about a fake.
 */
import { getStorage, type StorageAdapter } from '../../storage';
import { USERS, userDoc } from '../../storage/paths';
import type { UserLocale } from '../../storage/userDocument';
import { loadDomainState } from '../mobile/participantState';
import { readRoutineProfile } from '../mobile/routineProfileService';
import { keptFocusWindow } from '../../memoryGrowth/suggestionService';
import {
  projectBlockProtectionIntoPlanningConstraints,
  reconcileScheduleBlocks,
  schedulePlan,
} from '../../planning/scheduler';
import { projectReadinessIntoPlanningConstraints } from '../../planning/scheduler/readiness';
import { toEpochMs } from '../../planning/shared/time';
import type { PlanningConfig, PlanningConstraints } from '../../../src/contracts/v1/planningContracts';
import type { ScheduleBlock } from '../../../src/contracts/v1/scheduleBlockContracts';
import type { Commitment } from '../../../src/domain/stateMachine';
import {
  buildDailyPlanInput,
  dailyPlanScheduleSources,
  dayHorizon,
  type BusyBlockReader,
} from './buildDailyPlan';
import { readBusyBlocksForPlanning } from '../../calendar/busyBlocks';
import { explanationFactsFrom } from './explanationValidator';
import { explainPlan, type ExplanationDeps } from './explanationService';
import {
  NO_EDITS,
  appendPlanEvent,
  createIfAbsent,
  readStoredPlan,
  type StoredDailyPlan,
} from './planStore';
import {
  DEFAULT_CONTINUOUS_REPLAN_ENABLED,
  localDateOf,
  nextDeliveryAt,
  parseDeliveryLocalTime,
  planSettingsOf,
  PlanSettingsValidationError,
  type PlanSettings,
  type PlanSettingsBearingUser,
} from './planSettings';
import { DEFAULT_MOBILE_TIMEZONE } from '../mobile/time';
import type { MessagingClient } from '../../push/pushService';
import { planReadyPushSender } from './planReadyPush';
import {
  deliverPlanPush,
  firstPushPending,
  planPushDedupeKey,
  runPlanPushRetries,
  type PlanPushPending,
} from './planPushRetry';
import { composeCurrentUserState } from '../../userState/userStateService';
import { refreshStalePlan } from './planRefresh';

/** Accounts examined per tick. The issue's batch size. */
export const DAILY_PLAN_BATCH = 50;

/**
 * The notification a finished plan sends.
 *
 * `dedupeKey` is `plan:{date}`, so even a push layer that is retried at its own
 * level sends one. A push retry after a send that *threw* carries
 * `plan:{date}:retry{n}` instead (#431, `planPushDedupeKey`).
 * `planReadyMessage` turns this into UC-3.0b (#184)'s `PushMessage`;
 * `locale` is the plan's, so the text matches the explanation.
 */
export interface PlanReadyNotice {
  readonly uid: string;
  readonly kind: 'plan_ready';
  readonly dedupeKey: string;
  readonly data: { readonly planDate: string };
  readonly respectQuietHours: true;
  readonly urgency: 'normal';
  readonly locale: UserLocale;
}

/**
 * Sends the notice. A sender that reports a `status` other than `sent` — quiet
 * hours, no reachable device, a revoked account, a duplicate — is counted as
 * not pushed; a sender that reports nothing is taken at its word.
 */
export type PlanPushSender = (notice: PlanReadyNotice) => Promise<void | { readonly status: string }>;

export interface DailyPlanDeps {
  storage?: StorageAdapter;
  busyBlocks?: BusyBlockReader;
  push?: PlanPushSender;
  explanation?: ExplanationDeps;
  /**
   * The FCM client the default sender uses. Injected by tests that exercise the
   * production push path without a network; ignored when `push` is given.
   */
  messaging?: MessagingClient;
  /** Injected so a build is reproducible in a test. */
  now?: () => Date;
}

function storageOf(deps: DailyPlanDeps): StorageAdapter {
  return deps.storage ?? getStorage();
}

/**
 * The production reader (UC-3.2, #186).
 *
 * Bound to the adapter this build is already using rather than reaching for
 * `getStorage()` of its own, so a test that hands the service one store cannot
 * have its busy time read out of another.
 *
 * All-day entries are dropped inside `readBusyBlocksForPlanning`, which is
 * #186's decision: a birthday is not eight hours of unavailable time, and a
 * planner that treated one as blocking would answer "nothing fits" for a day
 * the user is perfectly able to work in.
 */
function storedBusyBlocks(storage: StorageAdapter): BusyBlockReader {
  return (uid, window) => readBusyBlocksForPlanning(uid, window, { storage });
}

export interface DeliveryClaim {
  readonly uid: string;
  /** The local date the claimed delivery is for. */
  readonly date: string;
  readonly settings: PlanSettings;
}

/**
 * What one attempt to claim an account's delivery came to.
 *
 * Three answers rather than two, because "nothing was claimed" hid a defect
 * that disabled the feature for everybody. `listDueAccounts` filters on the raw
 * fields; `claimDueDelivery` re-validates through `planSettingsOf`, which reads
 * an unrecognisable record as the defaults — `enabled: false` — and claimed
 * nothing. `nextRunAt` was then never advanced, so the record came back in the
 * next sweep, and the next, for ever. The query is
 * `orderBy nextRunAt asc limit 50`, so those records sort **first**: fifty of
 * them are the whole batch, and the totals read `due: 1, claimed: 0, failed: 0`
 * with nothing in the log to say why nobody got a plan.
 */
export type DeliveryClaimOutcome =
  | { readonly kind: 'claimed'; readonly claim: DeliveryClaim }
  | { readonly kind: 'not_due' }
  /** The sweep matched this record and nothing here can read it. */
  | { readonly kind: 'unreadable' };

/** `undefined` when the value is not an instant this code can compare. */
function instantMs(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Takes this account's due delivery, or says why it did not.
 *
 * ── The date is the user's today, not the instant's date ─────────
 *
 * A tick that runs late must still build the morning it was late for, and on
 * every ordinary morning `nextRunAt` and `now` fall on the same local date, so
 * the two readings agree. They part when the claim is **stale** — and it can
 * be, on the launch path rather than in theory: `infra/scheduler.sh` is an
 * owner action, so the cron does not exist until somebody runs it, while
 * `PUT /api/mobile/settings/plan` is live the moment the deploy lands. Every
 * account that enables delivery before the job is provisioned holds a week-old
 * `nextRunAt` the first time the sweep runs.
 *
 * Dating the plan by that instant wrote `plans/2026-09-07` and pushed
 * `plan:2026-09-07` on the 14th: a notification about a date whose `GET` is a
 * 404. So the plan is dated by the user's clock **now**. Since a claim is only
 * taken when `nextRunAt <= now`, that is the later of the two readings and
 * never an earlier one.
 *
 * ── And the timezone is the account's as it is now ───────────────
 *
 * `settings.timezone` comes from `planSettingsOf`, which prefers
 * `users/{uid}.timezone` over the snapshot the last PUT wrote. A move therefore
 * moves the plan's date, the zone it is built in, and — through
 * `nextDeliveryAt` below — the instant of every delivery after this one. The
 * delivery being claimed right now is the last one that lands at the old wall
 * clock; it is still built and stored, because skipping it would cost the user
 * a morning silently, and its push carries `respectQuietHours`.
 */
export async function claimDueDeliveryOutcome(
  uid: string,
  now: Date,
  deps: DailyPlanDeps = {},
): Promise<DeliveryClaimOutcome> {
  const nowIso = now.toISOString();
  const nowMs = toEpochMs(nowIso);
  return storageOf(deps).runTransaction<DeliveryClaimOutcome>(async (tx) => {
    const user = await tx.get<PlanSettingsBearingUser>(userDoc(uid));
    const raw = (user?.planSettings ?? null) as Record<string, unknown> | null;
    const rawArmed = raw !== null && raw.enabled === true && raw.nextRunAt !== undefined;
    const rawNextMs = rawArmed ? instantMs(raw!.nextRunAt) : undefined;
    // The sweep's own predicate, as the query applied it. `undefined` — a
    // `nextRunAt` that is present and not a parseable instant — counts as due,
    // because Firestore compares it as a string and returns it.
    const sweepMatched = rawArmed && (rawNextMs === undefined || rawNextMs <= nowMs);

    /** Takes the record out of every future sweep without inventing settings. */
    const dropNextRunAt = (): DeliveryClaimOutcome => {
      const { nextRunAt: _armed, ...keep } = raw ?? {};
      // The rest of the record is written back untouched: it may have been
      // written by a schema this build does not know, and replacing it with
      // this build's defaults would destroy a preference rather than skip a
      // morning. Absent, never null — see `planSettings`'s header.
      tx.set(userDoc(uid), { ...(user ?? {}), planSettings: keep });
      return { kind: 'unreadable' };
    };

    const settings = planSettingsOf(user, user?.timezone ?? DEFAULT_MOBILE_TIMEZONE);
    if (!settings.enabled || !settings.nextRunAt) {
      return sweepMatched ? dropNextRunAt() : { kind: 'not_due' };
    }
    const dueMs = instantMs(settings.nextRunAt);
    if (dueMs === undefined) return dropNextRunAt();
    if (dueMs > nowMs) return { kind: 'not_due' };

    const date = localDateOf(nowIso, settings.timezone);
    // Advanced from `now`, not from the instant claimed: after an outage a
    // single tick owes one morning, not every morning it slept through.
    const claimed: PlanSettings = {
      ...settings,
      nextRunAt: nextDeliveryAt(nowIso, settings),
      lastDeliveredDate: date,
    };
    // The whole document, read and written in one transaction. `merge` is not
    // used because the two adapters disagree about nested maps, and this write
    // has to *remove* nothing and replace `planSettings` entirely.
    tx.set(userDoc(uid), { ...(user ?? {}), planSettings: claimed });
    return { kind: 'claimed', claim: { uid, date, settings: claimed } };
  });
}

/** The claim, or nothing. `claimDueDeliveryOutcome` says which kind of nothing. */
export async function claimDueDelivery(
  uid: string,
  now: Date,
  deps: DailyPlanDeps = {},
): Promise<DeliveryClaim | null> {
  const outcome = await claimDueDeliveryOutcome(uid, now, deps);
  return outcome.kind === 'claimed' ? outcome.claim : null;
}

export interface DailyPlanBuild {
  readonly uid: string;
  readonly date: string;
  /** False when a plan for this date already existed: nothing was written. */
  readonly created: boolean;
  /** True when the push layer reports it delivered, or reports nothing. */
  readonly pushed: boolean;
  readonly stored: StoredDailyPlan;
}

/** Titles, keyed by commitment id, for the explanation and the API. */
export function titlesOf(commitments: readonly Commitment[]): Map<string, string> {
  return new Map(commitments.map((commitment) => [commitment.id, commitment.title]));
}

export interface PlanLayerProjectionInput {
  readonly uid: string;
  /** The clock the solve is happening on; readiness is resolved against it. */
  readonly now: string;
  readonly timezone: string;
  readonly commitments: readonly Commitment[];
  readonly busyBlocks: readonly { readonly startsAt: string; readonly endsAt: string }[];
  /** `buildDailyPlanInput`'s output, before anything below has touched it. */
  readonly constraints: PlanningConstraints;
  /** The blocks of the generation being replaced; null on a day's first build. */
  readonly previousBlocks: readonly ScheduleBlock[] | null;
}

/**
 * Everything the solver must see that `buildDailyPlanInput` cannot know
 * (#522, #585), and the one place it is added.
 *
 * Both solvers of a day go through here: `composeDailyPlan` (the morning build
 * and every regeneration) and `continuousReplanService` (the automatic
 * replan). They did not always. The replan once solved `buildDailyPlanInput`'s
 * bare output, so a protected hour held through every rebuild the user asked
 * for and was given away by the first calendar change nobody asked about — and
 * the reconciled blocks, built from unprotected items, dropped the protection
 * from the document as well. One function is what keeps the two from drifting
 * again; a second copy of these lines in the replan would be free to.
 *
 * Two projections, in this order. Readiness widens an item's after-buffer;
 * protection (#522) states whose decision an item's position is. They commute
 * — neither reads what the other writes — but the order is written down rather
 * than left to whichever line someone adds next, because the result is what
 * `inputDigest` is taken over and a reordering that changed a buffer would
 * change every digest.
 *
 * The protections come from the *previous generation's blocks*: a protection
 * is declared on a block, which is the plan layer's own state, and this is the
 * one place it re-enters the solver's input. Without it a solve would rebuild
 * every item from commitments that have never heard of it. The first build of
 * a day has no previous blocks and therefore no protections, which is
 * correct: nothing has been placed to protect yet.
 *
 * Readiness is resolved at `now`, not at the time of the plan being replaced.
 * A replan that kept the morning's reading would be solving for a person the
 * morning saw; one that dropped it would pack the day without the recovery gap
 * the morning gave, and every tighter placement would reach the diff as churn
 * although nothing about the person changed.
 */
export async function projectPlanLayerIntoConstraints(
  input: PlanLayerProjectionInput,
  deps: { readonly storage: StorageAdapter; readonly userDocument: unknown },
): Promise<PlanningConstraints> {
  const userState = await composeCurrentUserState({
    uid: input.uid,
    now: input.now,
    busy: input.busyBlocks.map((block) => ({
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      timezone: input.timezone,
    })),
    deadlines: input.commitments.flatMap((commitment) => {
      const dueAt = commitment.timeSpec.kind === 'due_by' ? commitment.timeSpec.dueAt : null;
      return dueAt
        ? [{ deadlineId: commitment.id, dueAt, kind: 'commitment' as const, sourceRef: null }]
        : [];
    }),
  }, { storage: deps.storage, userDocument: deps.userDocument });
  return projectBlockProtectionIntoPlanningConstraints(
    projectReadinessIntoPlanningConstraints(input.constraints, userState.projection.readiness),
    input.previousBlocks,
  );
}

export interface DailyPlanRequestInput {
  readonly uid: string;
  /** The local calendar date being planned, `YYYY-MM-DD`. */
  readonly date: string;
  readonly timezone: string;
  /** The clock the solve is happening on. */
  readonly now: string;
  /** The account document the caller already read; readiness is composed from it. */
  readonly userDocument: unknown;
  /** The blocks of the generation being replaced; null on a day's first build. */
  readonly previousBlocks: readonly ScheduleBlock[] | null;
}

export interface DailyPlanRequest {
  /** What the request was built from, for the caller's titles. */
  readonly commitments: readonly Commitment[];
  /** What the solver is given: `buildDailyPlanInput`'s output, projected. */
  readonly constraints: PlanningConstraints;
  readonly config: PlanningConfig;
}

/**
 * The planning request for one account's day, read and assembled in one place
 * (#606).
 *
 * Both solvers of a day build their request here: `composeDailyPlan` (the
 * morning build and every regeneration) and `continuousReplanService` (the
 * automatic replan). #604 unified the plan-layer half of the request
 * (`projectPlanLayerIntoConstraints`); this is the other half, the reads that
 * feed `buildDailyPlanInput`. They used to be assembled separately, and the
 * replan's copy had drifted: it never read the kept focus window. For a user
 * whose routine names no focus window, the morning plan was solved inside the
 * window they kept and every replan fell back to 08:00–20:00 and repacked the
 * day at "now". The diff charged that repacking to whichever change triggered
 * the replan.
 *
 * ── The focus hint and its gate ──────────────────────────────────
 *
 * Read only when it could matter: a routine with focus windows outranks it.
 * `keptFocusWindow` answers null without personalization consent, so
 * withdrawing consent takes the hint out of the next plan (UC-3.16, #202), and
 * out of the next replan. Nothing here reads the memory any other way.
 *
 * ── The busy-block horizon is the day being solved ───────────────
 *
 * Busy time is read over `dayHorizon(date, timezone)`, for both solvers,
 * because that is the horizon `buildDailyPlanInput` builds the request over.
 * The replan used to read over the stored plan's horizon instead. That is
 * the same span whenever the zone has not changed since the plan was built,
 * since that horizon *is* `dayHorizon` taken at build time. When the account has
 * moved zones, though, the request is solved over the new zone's day while
 * the busy read covered the old one, and the solve is blind to calendar time in
 * the hours the two days do not share. Reading over the span the request is
 * solved over is the only choice that cannot disagree with the request.
 */
export async function composeDailyPlanRequest(
  input: DailyPlanRequestInput,
  deps: { readonly storage: StorageAdapter; readonly busyBlocks?: BusyBlockReader },
): Promise<DailyPlanRequest> {
  const { uid, date, timezone, now } = input;
  const storage = deps.storage;

  const state = await loadDomainState(storage, uid);
  const commitments = Object.values(state.commitments);
  const profile = await readRoutineProfile(uid, { storage });
  const focusHint = (profile?.focusWindows ?? []).length > 0
    ? null
    : await keptFocusWindow(uid, now, { storage });
  const busyBlocks = await (deps.busyBlocks ?? storedBusyBlocks(storage))(uid, dayHorizon(date, timezone));

  const { constraints: baseConstraints, config } = buildDailyPlanInput({
    uid,
    date,
    timezone,
    commitments,
    busyBlocks,
    profile,
    focusHint,
    // The clock this build is happening on (#500). Without it the mapping
    // filled the working window from its start, so a plan built at 13:44
    // scheduled the whole day at 09:00 and was over before it was shown.
    builtAt: now,
  });
  const constraints = await projectPlanLayerIntoConstraints({
    uid,
    now,
    timezone,
    commitments,
    busyBlocks,
    constraints: baseConstraints,
    previousBlocks: input.previousBlocks,
  }, { storage, userDocument: input.userDocument });
  return { commitments, constraints, config };
}

/**
 * What a regeneration carries forward from the plan it replaces (#521).
 *
 * The blocks are the reconciler's provenance input (a block the new plan does
 * not place keeps the record of who last placed it — see `blocks.ts`,
 * property 4); the generation and digest become the new document's `replaces`
 * link. Identity itself is *not* carried: block ids are derived from the
 * occurrence, so the new build arrives at them on its own.
 */
export interface PlanGenerationAncestryInput {
  readonly previousGeneration: number;
  readonly previousInputDigest: string;
  readonly previousBlocks: readonly ScheduleBlock[];
}

/**
 * Builds the plan document for one account and one local date.
 *
 * Pure of decisions about *whether* it should run: the caller has claimed, or
 * the user has asked for a regeneration. What it decides is what the plan is.
 */
export async function composeDailyPlan(
  uid: string,
  date: string,
  settings: Pick<PlanSettings, 'timezone'>,
  generation: number,
  deps: DailyPlanDeps = {},
  ancestry?: PlanGenerationAncestryInput,
): Promise<StoredDailyPlan> {
  const storage = storageOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  const timezone = settings.timezone;

  const user = await storage.get<PlanSettingsBearingUser>(userDoc(uid));
  const locale: UserLocale = user?.locale === 'ar' || user?.locale === 'he' ? user.locale : 'en';

  const { commitments, constraints, config } = await composeDailyPlanRequest({
    uid,
    date,
    timezone,
    now: now.toISOString(),
    userDocument: user,
    previousBlocks: ancestry?.previousBlocks ?? null,
  }, { storage, ...(deps.busyBlocks ? { busyBlocks: deps.busyBlocks } : {}) });
  const plan = schedulePlan(constraints, config);
  // One block per occurrence the planner was asked about, placements applied
  // back. Throws `ScheduleBlockIntegrityError` — and the build fails — if the
  // plan and the request ever disagree about what exists, which is a planner
  // bug and must not be persisted as if it were a plan (#521).
  const blocks = reconcileScheduleBlocks({
    constraints,
    plan,
    generation,
    sources: dailyPlanScheduleSources(constraints),
    previous: ancestry?.previousBlocks ?? null,
  });

  const titles = titlesOf(commitments);
  const facts = explanationFactsFrom(plan, titles, timezone, locale);
  const { explanation } = await explainPlan(uid, plan, titles, facts, timezone, {
    storage,
    ...(deps.explanation ?? {}),
  });

  return {
    date,
    timezone,
    locale,
    status: 'proposed',
    plan,
    blocks,
    replaces: ancestry
      ? { generation: ancestry.previousGeneration, inputDigest: ancestry.previousInputDigest }
      : null,
    constraints,
    config,
    explanation,
    edits: NO_EDITS,
    generatedAt: now.toISOString(),
    generation,
    inputDigest: plan.inputDigest,
    acceptedAt: null,
    updatedAt: now.toISOString(),
  };
}

/**
 * The one way a day's first plan comes into existence (#194, #477).
 *
 * Both callers go through here — the morning tick and the user's own "Build
 * today's plan" — so they cannot drift into two generation paths. It composes
 * generation 1, writes it with `createIfAbsent`, and records `plan_proposed`
 * only when this call is the one that wrote it. What it does not do is notify;
 * that is the caller's decision, taken on `created`.
 *
 * A plan that is already stored is returned before anything is composed: a
 * repeated build must spend nothing, and composing is where a model call would
 * be spent. The read is an optimisation, not the lock — two builds that both
 * miss it still meet in `createIfAbsent`'s transaction, and only one writes.
 */
async function storeFirstPlan(
  uid: string,
  date: string,
  settings: Pick<PlanSettings, 'timezone'>,
  deps: DailyPlanDeps,
  /**
   * The push this plan will owe, for a caller that is about to send one
   * (#431). Written in the same write as the plan, so a crash after it cannot
   * leave a plan that nobody knows still needs its push. Asked for after the
   * compose, so its lease starts when the plan is stored rather than when the
   * compose began.
   */
  pushPending?: () => PlanPushPending,
): Promise<{ created: boolean; stored: StoredDailyPlan }> {
  const storage = storageOf(deps);
  const existing = await readStoredPlan(uid, date, storage);
  if (existing) return { created: false, stored: existing };

  const composed = await composeDailyPlan(uid, date, settings, 1, deps);
  const document: StoredDailyPlan = pushPending ? { ...composed, pushPending: pushPending() } : composed;
  const { created, stored } = await createIfAbsent(uid, document, storage);
  if (!created) return { created: false, stored };

  await appendPlanEvent(uid, {
    type: 'plan_proposed',
    date: stored.date,
    at: stored.generatedAt,
    generation: stored.generation,
    inputDigest: stored.inputDigest,
  }, storage);
  return { created: true, stored };
}

/**
 * A user-requested build for a date outside today and tomorrow (#477).
 *
 * `MAX_PLAN_GENERATIONS_PER_DAY` is a cap per *date*, so a creating build that
 * took any date would let one account walk the calendar and spend a model call
 * and a stored document on each day of it.
 */
export class PlanDateOutOfRangeError extends Error {
  readonly reason = 'date_out_of_range' as const;
  constructor(readonly date: string) {
    super('a plan can only be built for today or tomorrow');
    this.name = 'PlanDateOutOfRangeError';
  }
}

/** The calendar date after a `YYYY-MM-DD`. Civil arithmetic, no zone. */
function nextCivilDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Builds a plan because the user asked for one on the plan screen (#477).
 *
 * The morning build without the push: they are looking at the screen the push
 * would have opened. Everything else is the tick's — the zone is the account's
 * as `readPlanSettings` reads it (the same `planSettingsOf` the claim uses),
 * the plan is generation 1 and so counts toward `MAX_PLAN_GENERATIONS_PER_DAY`,
 * and a date that already has a plan gets that plan back untouched.
 *
 * It does not claim the delivery and does not touch `planSettings`. A tick that
 * later claims this morning meets the stored document in `createIfAbsent`,
 * reports `created: false`, and so sends nothing.
 *
 * A stored plan comes back as a reader sees it (`refreshStalePlan`): rebuilt
 * when the day's commitments have changed since it was built and the person
 * has not touched it, flagged `inputsChanged` when they have. Returning it
 * untouched is what left a plan built before the first capture empty for the
 * rest of the day.
 */
export async function buildDailyPlanOnDemand(
  uid: string,
  date: string,
  deps: DailyPlanDeps = {},
): Promise<DailyPlanBuild & { readonly inputsChanged: boolean }> {
  // A stored plan is returned whatever its date; `refreshStalePlan` decides
  // whether it is still the day's (and never rebuilds a past one).
  const existing = await readStoredPlan(uid, date, storageOf(deps));
  if (existing) {
    const current = await refreshStalePlan(uid, existing, {
      storage: storageOf(deps),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.busyBlocks ? { busyBlocks: deps.busyBlocks } : {}),
    });
    return { uid, date, created: false, pushed: false, stored: current.stored, inputsChanged: current.inputsChanged };
  }

  // Creating one is refused outside the account's today and tomorrow, before
  // anything is composed. Here and not in the route, so no caller skips it;
  // the morning tick does not come through here and is dated by its claim.
  const settings = await readPlanSettings(uid, deps);
  const today = localDateOf((deps.now ?? (() => new Date()))().toISOString(), settings.timezone);
  if (date !== today && date !== nextCivilDate(today)) throw new PlanDateOutOfRangeError(date);

  const { created, stored } = await storeFirstPlan(uid, date, settings, deps);
  return { uid, date, created, pushed: false, stored, inputsChanged: false };
}

/**
 * Builds and stores this account's plan, and notifies once if it was new.
 *
 * The push is inside the `created` branch and nowhere else. That single
 * placement is what makes "one plan document and one push" one fact rather than
 * two things that have to agree.
 */
export async function buildAndStoreDailyPlan(
  claim: DeliveryClaim,
  deps: DailyPlanDeps = {},
): Promise<DailyPlanBuild> {
  const storage = storageOf(deps);
  const clock = deps.now ?? (() => new Date());
  const { created, stored } = await storeFirstPlan(
    claim.uid,
    claim.date,
    claim.settings,
    deps,
    () => firstPushPending(clock()),
  );

  if (!created) {
    return { uid: claim.uid, date: claim.date, created: false, pushed: false, stored };
  }

  // The plan exists from here on, whatever the push does. A push that throws —
  // FCM's `internal-error`, an unreadable device registry — used to escape this
  // function, so the tick counted the account `failed` and not `built` while
  // `plans/{date}` sat in storage. It is logged, reported as not pushed, and
  // does not fail the account. And since #431 it is not lost either: the plan
  // was stored owing attempt 1 of its push, `deliverPlanPush` records what this
  // attempt came to, and the sweep retries push-only from there.
  const { pushed } = await deliverPlanPush(
    {
      uid: claim.uid,
      date: stored.date,
      attempt: 1,
      dedupeKey: planPushDedupeKey(stored.date, 0),
      locale: stored.locale,
    },
    planPushSenderOf(deps),
    clock(),
    storage,
  );

  return { uid: claim.uid, date: claim.date, created: true, pushed, stored };
}

/** The injected sender, or the production one bound to this build's storage. */
function planPushSenderOf(deps: DailyPlanDeps): PlanPushSender {
  return deps.push ?? planReadyPushSender({
    storage: storageOf(deps),
    ...(deps.messaging ? { messaging: deps.messaging } : {}),
    now: deps.now ?? (() => new Date()),
  });
}

export interface DailyPlanTickTotals {
  /** Accounts the query said were due. */
  due: number;
  /** Accounts this tick claimed. */
  claimed: number;
  /** Plan documents this tick created. */
  built: number;
  /**
   * Plans whose push the push layer delivered. At most `built`, by construction:
   * the push is inside the `created` branch. Less than `built` when an account
   * had no reachable device, was in quiet hours, or has asked not to be pushed.
   */
  pushed: number;
  /**
   * Push-only retries of plans built earlier (#431): attempts this tick sent,
   * the ones delivered, and pending pushes it gave up. Never counted in
   * `built` or `pushed`, which stay about this tick's own builds.
   */
  retried: number;
  retryPushed: number;
  retryDropped: number;
  failed: number;
}

export interface DailyPlanTickOptions extends DailyPlanDeps {
  limit?: number;
}

/**
 * Every account whose delivery instant has arrived.
 *
 * Both conditions are in the query rather than one of them being applied in
 * code, so the two storage adapters return the same set. Firestore omits a
 * document whose queried field is absent; the memory adapter ranks `undefined`
 * below every string and would have returned every account that never enabled
 * the feature.
 */
export async function listDueAccounts(
  now: Date,
  deps: DailyPlanDeps = {},
  limit = DAILY_PLAN_BATCH,
): Promise<string[]> {
  const rows = await storageOf(deps).list<PlanSettingsBearingUser>(USERS, {
    where: [
      ['planSettings.enabled', '==', true],
      ['planSettings.nextRunAt', '<=', now.toISOString()],
    ],
    orderBy: { field: 'planSettings.nextRunAt', direction: 'asc' },
    limit,
  });
  return rows.map((row) => row.id);
}

/**
 * One sweep.
 *
 * Each account is claimed and built inside its own try/catch: one account with
 * an unreadable profile, an unresolvable timezone or a provider that throws
 * must not stop the other forty-nine from getting their morning. A failure is
 * counted and logged without the account's data, and the account's `nextRunAt`
 * has already moved, so the failure costs one morning rather than becoming a
 * loop that retries the same broken account every minute for ever.
 */
export async function runDailyPlanTick(options: DailyPlanTickOptions = {}): Promise<DailyPlanTickTotals> {
  const now = (options.now ?? (() => new Date()))();
  const totals: DailyPlanTickTotals = {
    due: 0, claimed: 0, built: 0, pushed: 0, retried: 0, retryPushed: 0, retryDropped: 0, failed: 0,
  };
  const due = await listDueAccounts(now, options, options.limit ?? DAILY_PLAN_BATCH);
  totals.due = due.length;

  for (const uid of due) {
    try {
      const outcome = await claimDueDeliveryOutcome(uid, now, options);
      if (outcome.kind === 'unreadable') {
        // Counted and said out loud. Before this, such a record advanced
        // nothing, sorted first in every sweep for ever, and showed up as
        // `due: 1, claimed: 0, failed: 0` — a batch that silently went nowhere.
        totals.failed += 1;
        console.error('[internal/jobs/daily-plan] a due account has unreadable plan settings; its delivery was disarmed');
        continue;
      }
      if (outcome.kind !== 'claimed') continue;
      const claim = outcome.claim;
      totals.claimed += 1;
      const result = await buildAndStoreDailyPlan(claim, options);
      if (result.created) totals.built += 1;
      if (result.pushed) totals.pushed += 1;
    } catch (error) {
      totals.failed += 1;
      // The uid is not logged: a plan failure is not worth putting an account
      // identifier in a log line that a support conversation never needs.
      console.error('[internal/jobs/daily-plan] one account failed', error);
    }
  }

  // The push-only half (#431), after the builds so a plan this tick stored
  // is never retried by the same tick: its lease has only just begun. Its own
  // try/catch, so a sweep query Firestore refuses (the index is an owner
  // deploy) costs the retries, never the mornings built above.
  try {
    const retries = await runPlanPushRetries(
      now,
      planPushSenderOf(options),
      storageOf(options),
      options.limit ?? DAILY_PLAN_BATCH,
    );
    totals.retried = retries.retried;
    totals.retryPushed = retries.retryPushed;
    totals.retryDropped = retries.retryDropped;
    totals.failed += retries.failed;
  } catch (error) {
    totals.failed += 1;
    console.error('[internal/jobs/daily-plan] the pending-push sweep failed', error instanceof Error ? error.name : 'unknown');
  }
  return totals;
}

export interface PlanSettingsInput {
  /**
   * The morning delivery. Omitted keeps the stored value *and* the stored
   * `nextRunAt` (#523): the replanning switch saves through this same record,
   * and a client that had to re-send `enabled` could only send the value in its
   * cache — so a phone that had not seen another device turn the morning plan
   * on would turn it back off. A write that does not name `enabled` does not
   * touch the delivery at all.
   */
  readonly enabled?: boolean;
  readonly deliveryLocalTime?: string;
  /**
   * Whether continuous replanning may act on this account (#523, AC 9).
   *
   * Omitted leaves whatever the account already chose, exactly as an omitted
   * `deliveryLocalTime` does. It is a separate field from `enabled` because it
   * is a separate promise: an account can want a morning plan and not want it
   * rewritten during the day, or the reverse.
   */
  readonly continuousReplanEnabled?: boolean;
}

/** The settings this account has, with the defaults filled in. */
export async function readPlanSettings(uid: string, deps: DailyPlanDeps = {}): Promise<PlanSettings> {
  const user = await storageOf(deps).get<PlanSettingsBearingUser>(userDoc(uid));
  return planSettingsOf(user, user?.timezone ?? DEFAULT_MOBILE_TIMEZONE);
}

/**
 * Records what the user chose, and arms or disarms the delivery.
 *
 * The timezone is the account's, never the request's: `users/{uid}.timezone` is
 * what every other dated read in this product uses, and letting a plan settings
 * call set it would give one screen the power to move every other screen's day
 * boundary. It is also read again at delivery rather than trusted from here —
 * see `planSettingsOf` — so what this writes is a record of the zone the
 * `nextRunAt` beside it was computed under, not the account's standing answer.
 *
 * Switching delivery off **removes** `nextRunAt` rather than nulling it. A null
 * would keep the account in the result set of every future sweep — Firestore
 * ranks null below every string, so `nextRunAt <= now` would match it for ever —
 * which is a disabled account being woken up by a query that was supposed to
 * have forgotten it.
 */
export async function savePlanSettings(
  uid: string,
  input: PlanSettingsInput,
  now: Date,
  deps: DailyPlanDeps = {},
): Promise<PlanSettings> {
  return storageOf(deps).runTransaction(async (tx) => {
    const user = await tx.get<PlanSettingsBearingUser>(userDoc(uid));
    const current = planSettingsOf(user, user?.timezone ?? DEFAULT_MOBILE_TIMEZONE);
    const deliveryLocalTime = input.deliveryLocalTime ?? current.deliveryLocalTime;
    // Throws `PlanSettingsValidationError` on anything that is not HH:mm, which
    // the route turns into a 400 before anything is written.
    parseDeliveryLocalTime(deliveryLocalTime);
    // Validated here rather than only at the route, for the reason
    // `deliveryLocalTime` is: the route is one caller of this transaction, and
    // a value that reached storage unchecked would read back as a gate nobody
    // can reason about.
    if (input.continuousReplanEnabled !== undefined && typeof input.continuousReplanEnabled !== 'boolean') {
      throw new PlanSettingsValidationError(
        'continuousReplanEnabled must be a boolean',
        'invalid_continuous_replan_enabled',
      );
    }
    const continuousReplanEnabled = input.continuousReplanEnabled
      ?? current.continuousReplanEnabled
      ?? DEFAULT_CONTINUOUS_REPLAN_ENABLED;
    const timezone = user?.timezone ?? current.timezone;

    const keepsDelivery = input.enabled === undefined;
    const enabled = keepsDelivery ? current.enabled === true : input.enabled === true;
    const base = { enabled, deliveryLocalTime, timezone, continuousReplanEnabled };
    const next: PlanSettings = base.enabled
      ? {
        ...base,
        // Re-armed only by a write that is about the delivery. One that is not
        // (the replanning switch) leaves an armed delivery exactly where it was.
        nextRunAt: keepsDelivery && input.deliveryLocalTime === undefined && current.nextRunAt
          ? current.nextRunAt
          : nextDeliveryAt(now.toISOString(), base),
        ...(current.lastDeliveredDate ? { lastDeliveredDate: current.lastDeliveredDate } : {}),
      }
      // No `nextRunAt` key at all — see the header.
      : { ...base, ...(current.lastDeliveredDate ? { lastDeliveredDate: current.lastDeliveredDate } : {}) };

    tx.set(userDoc(uid), { ...(user ?? {}), planSettings: next });
    return next;
  });
}

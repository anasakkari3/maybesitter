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
 * **What neither layer covers, stated plainly:** a crash *between* the plan
 * write and the push. The claim has advanced, the document exists, and nobody
 * is told — and no replay exists that would notice, because `createIfAbsent`
 * makes a replay *safe* without making one *happen*. That is one lost morning
 * per crash, recovered by the user opening the app. UC-3.0b (#184) landed a
 * dedupe lock, not a queue, so this is still open.
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
import { schedulePlan } from '../../planning/scheduler';
import { toEpochMs } from '../../planning/shared/time';
import type { Commitment } from '../../../src/domain/stateMachine';
import {
  buildDailyPlanInput,
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
  type StoredDailyPlan,
} from './planStore';
import {
  localDateOf,
  nextDeliveryAt,
  parseDeliveryLocalTime,
  planSettingsOf,
  type PlanSettings,
  type PlanSettingsBearingUser,
} from './planSettings';
import { DEFAULT_MOBILE_TIMEZONE } from '../mobile/time';
import type { MessagingClient } from '../../push/pushService';
import { planReadyPushSender } from './planReadyPush';

/** Accounts examined per tick. The issue's batch size. */
export const DAILY_PLAN_BATCH = 50;

/**
 * The notification a finished plan sends.
 *
 * `dedupeKey` is `plan:{date}`, so even a push layer that is retried at its own
 * level sends one. `planReadyMessage` turns this into UC-3.0b (#184)'s
 * `PushMessage`; `locale` is the plan's, so the text matches the explanation.
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
): Promise<StoredDailyPlan> {
  const storage = storageOf(deps);
  const now = (deps.now ?? (() => new Date()))();
  const timezone = settings.timezone;

  const user = await storage.get<PlanSettingsBearingUser>(userDoc(uid));
  const locale: UserLocale = user?.locale === 'ar' || user?.locale === 'he' ? user.locale : 'en';

  const state = await loadDomainState(storage, uid);
  const commitments = Object.values(state.commitments);
  const profile = await readRoutineProfile(uid, { storage });
  const horizon = dayHorizon(date, timezone);
  const busyBlocks = await (deps.busyBlocks ?? storedBusyBlocks(storage))(uid, horizon);

  const { constraints, config } = buildDailyPlanInput({
    uid,
    date,
    timezone,
    commitments,
    busyBlocks,
    profile,
  });
  const plan = schedulePlan(constraints, config);

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
  const document = await composeDailyPlan(claim.uid, claim.date, claim.settings, 1, deps);
  const { created, stored } = await createIfAbsent(claim.uid, document, storage);

  if (!created) {
    return { uid: claim.uid, date: claim.date, created: false, pushed: false, stored };
  }

  await appendPlanEvent(claim.uid, {
    type: 'plan_proposed',
    date: stored.date,
    at: stored.generatedAt,
    generation: stored.generation,
    inputDigest: stored.inputDigest,
  }, storage);

  const sender = deps.push ?? planReadyPushSender({
    storage,
    ...(deps.messaging ? { messaging: deps.messaging } : {}),
    now: deps.now ?? (() => new Date()),
  });
  // The plan exists from here on, whatever the push does. A push that throws —
  // FCM's `internal-error`, an unreadable device registry — used to escape this
  // function, so the tick counted the account `failed` and not `built` while
  // `plans/{date}` sat in storage. It is logged, reported as not pushed, and
  // does not fail the account. It is not retried: `nextRunAt` has moved, and
  // a retry is the quiet-hours question (#426 review F5), not this one.
  let pushed = false;
  try {
    const outcome = await sender({
      uid: claim.uid,
      kind: 'plan_ready',
      dedupeKey: `plan:${stored.date}`,
      data: { planDate: stored.date },
      respectQuietHours: true,
      urgency: 'normal',
      locale: stored.locale,
    });
    pushed = !outcome || outcome.status === 'sent';
  } catch (error) {
    // No uid, as with every other line this job logs.
    console.error('[internal/jobs/daily-plan] push_failed', error instanceof Error ? error.name : 'unknown');
  }

  return { uid: claim.uid, date: claim.date, created: true, pushed, stored };
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
  const totals: DailyPlanTickTotals = { due: 0, claimed: 0, built: 0, pushed: 0, failed: 0 };
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
  return totals;
}

export interface PlanSettingsInput {
  readonly enabled: boolean;
  readonly deliveryLocalTime?: string;
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
    const timezone = user?.timezone ?? current.timezone;

    const base = { enabled: input.enabled === true, deliveryLocalTime, timezone };
    const next: PlanSettings = base.enabled
      ? {
        ...base,
        nextRunAt: nextDeliveryAt(now.toISOString(), base),
        ...(current.lastDeliveredDate ? { lastDeliveredDate: current.lastDeliveredDate } : {}),
      }
      // No `nextRunAt` key at all — see the header.
      : { ...base, ...(current.lastDeliveredDate ? { lastDeliveredDate: current.lastDeliveredDate } : {}) };

    tx.set(userDoc(uid), { ...(user ?? {}), planSettings: next });
    return next;
  });
}

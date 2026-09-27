/**
 * Weekly planning mode, «خطّط أسبوعي» (CL5b; council verdict 2026-09-26, item 6).
 *
 * ── Not a planner: the daily planner, seven times ────────────────
 *
 * The strategy excludes a "complete planner", and the council held weekly mode
 * to that: the week is the **existing** daily planner run once per date,
 * today … today+6, each run through the same `composeDailyPlanRequest` the
 * morning build and every rebuild use, with an explicit `builtAt` (#500) and
 * that date's own busy time, routine and readiness. There is no second solver
 * here and no cross-day optimisation. What this module adds is only the
 * bookkeeping the per-date runs need so that one commitment is not proposed
 * on seven days at once.
 *
 * ── One step per day ──────────────────────────────────────────────
 *
 * The council's cap: each day proposes **one** realistic next step, fitted
 * around that day's busy time. Days are visited in order. A day's candidates
 * are the floating work the daily rule (`belongsToDay`) already puts on it,
 * minus what the week has placed elsewhere; the planner is run over all of
 * them, and the day's step is the first thing it places. The day is then
 * solved again over that step alone (plus anything the person moved there),
 * which is exactly the request an acceptance will compose — so the times
 * shown are the times stored.
 *
 * The daily rule is not reinterpreted. Undated work that matters belongs to
 * every day, so it fills the first free days one at a time; dated work
 * belongs to its due day and, under #383, to every day after it — so a step
 * that was due on a day whose step was something else is offered again the
 * next day, as yesterday's work rolls into today.
 *
 * ── Nothing is stored until a day is accepted ────────────────────
 *
 * A proposal is not a plan. `plans/{date}` *is* the day's plan: the morning
 * job skips a date that has one and every reader shows it. So the week is
 * recomputed from the account on every call and written nowhere — no draft
 * collection, nothing to delete, export or expire. The person's moves and
 * drops are the client's to hold until they accept, and arrive with each call
 * (`WeekDecisions`); decisions about work the week does not hold are ignored
 * rather than stored. That is the product's rule for every suggestion: nothing
 * is saved without an explicit confirm.
 *
 * Accepting a day is the daily flow: `storeWeekDayPlan` (the same build, a
 * generation that counts toward that date's cap) and then `acceptPlan` (the
 * same status, ledger entry and activity counter as "Looks good"). From then
 * on the day is an ordinary accepted plan — #626 keeps any automatic write off
 * it, #587 keeps a declined patch declined, the rebuild cap is its date's own —
 * with one record beside it, `weekPlan`, saying which of the day's work the
 * week held elsewhere (`planStore.ts`).
 *
 * A date that already has a plan is shown as that plan and never re-proposed:
 * the week does not rewrite a stored day, touched or not.
 */
import { getStorage, type StorageAdapter } from '../../storage';
import { userDoc } from '../../storage/paths';
import { schedulePlan } from '../../planning/scheduler';
import { toEpochMs } from '../../planning/shared/time';
import type { Plan, PlanningConstraints } from '../../../src/contracts/v1/planningContracts';
import type { Commitment } from '../../../src/domain/stateMachine';
import { buildDailyPlanInput, dayHorizon, fixedStartOf, pinnedEventsOnDay, type DayAssignment } from './buildDailyPlan';
import {
  PlanDateOutOfRangeError,
  composeDailyPlanRequest,
  preloadDailyPlanRequest,
  storeWeekDayPlan,
  titlesOf,
  type DailyPlanDeps,
} from './dailyPlanService';
import { acceptPlan, effectiveSchedule } from './planActions';
import { planToDto } from './planDto';
import { readStoredPlan, type StoredDailyPlan, type WeekPlanOrigin } from './planStore';
import { isPlanDate, localDateOf, planSettingsOf } from './planSettings';
import { PLAN_PROPOSAL_DAYS, heldBySavedWeekDay, planDatesFrom } from './weekHolds';
import { DEFAULT_MOBILE_TIMEZONE } from '../mobile/time';
import { reserveDailyAction } from '../../llm/usageGuard';

/* ── What the client sends ─────────────────────────────────────────── */

/** One step the person moved to another day of the week. */
export interface WeekMove {
  readonly itemId: string;
  readonly date: string;
}

/**
 * The person's decisions about this week's proposals, held by the client
 * until a day is accepted. `drops` are steps taken off the week ("not this
 * week"); nothing about the commitment itself changes.
 */
export interface WeekDecisions {
  readonly moves: readonly WeekMove[];
  readonly drops: readonly string[];
}

/** The daily counter both week routes spend (`reserveDailyAction`, I5). */
export const WEEK_PLAN_ACTION = 'week_propose';
/** Generous: a person moving steps around makes a call per move. A loop does not. */
export const MAX_WEEK_PLANS_PER_DAY = 300;
/** A full valid body is about 25 KB (50 moves, 50 drops, 50 shown ids of 200 characters). */
export const WEEK_BODY_LIMIT_BYTES = 32 * 1024;

/**
 * Spends one of today's week calls. False over the cap, and false when the
 * counter cannot be read: it fails closed like every daily action.
 */
export async function reserveWeekPlan(uid: string): Promise<boolean> {
  return await reserveDailyAction(uid, WEEK_PLAN_ACTION, MAX_WEEK_PLANS_PER_DAY) === 'ok';
}

/** 429 with a static message: nothing about the account in it. */
export function weekRateLimitedResponse(): Response {
  return Response.json(
    { success: false, error: 'too many week plans today', reason: 'week_rate_limited', maxPerDay: MAX_WEEK_PLANS_PER_DAY },
    { status: 429 },
  );
}

export const NO_WEEK_DECISIONS: WeekDecisions = Object.freeze({ moves: [], drops: [] });

/** A bound on the body, not a product rule: a week holds a handful of steps. */
export const MAX_WEEK_DECISIONS = 50;
const MAX_ID_LENGTH = 200;

export class WeekDecisionsInvalid extends Error {
  readonly reason = 'invalid_decisions' as const;
  constructor(message: string) {
    super(message);
    this.name = 'WeekDecisionsInvalid';
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** Parses `{ moves?, drops? }`. Throws `WeekDecisionsInvalid` on anything else. */
export function parseWeekDecisions(body: unknown): WeekDecisions {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new WeekDecisionsInvalid('the body must be an object');
  }
  const { moves = [], drops = [] } = body as { moves?: unknown; drops?: unknown };
  if (!Array.isArray(moves) || !Array.isArray(drops)) throw new WeekDecisionsInvalid('moves and drops must be lists');
  if (moves.length > MAX_WEEK_DECISIONS || drops.length > MAX_WEEK_DECISIONS) {
    throw new WeekDecisionsInvalid(`at most ${MAX_WEEK_DECISIONS} moves and ${MAX_WEEK_DECISIONS} drops`);
  }
  const parsedMoves = moves.map((move: unknown) => {
    const { itemId, date } = (typeof move === 'object' && move !== null ? move : {}) as { itemId?: unknown; date?: unknown };
    if (!isId(itemId) || !isPlanDate(date)) throw new WeekDecisionsInvalid('a move is { itemId, date: YYYY-MM-DD }');
    return { itemId, date };
  });
  const parsedDrops = drops.map((drop: unknown) => {
    if (!isId(drop)) throw new WeekDecisionsInvalid('a drop is an item id');
    return drop;
  });
  return { moves: parsedMoves, drops: parsedDrops };
}

/**
 * Parses the `shown` of an accept body: the ids of the steps the day's card
 * showed (its `items` and `unplaced`), which the saved day must equal (I1).
 * Required, bounded like the decisions. Throws `WeekDecisionsInvalid`.
 */
export function parseShown(body: unknown): string[] {
  const shown = typeof body === 'object' && body !== null ? (body as { shown?: unknown }).shown : undefined;
  if (!Array.isArray(shown)) throw new WeekDecisionsInvalid('shown must list the ids the day showed');
  if (shown.length > MAX_WEEK_DECISIONS) throw new WeekDecisionsInvalid(`at most ${MAX_WEEK_DECISIONS} shown ids`);
  return shown.map((itemId: unknown) => {
    if (!isId(itemId)) throw new WeekDecisionsInvalid('a shown id is an item id');
    return itemId;
  });
}

/* ── The week, composed ────────────────────────────────────────────── */

/**
 * Why a step is on its day, as the card says it. Codes, never text.
 *
 * `carried` is work due on a day that has already gone (#383's roll-over);
 * `due_earlier` is work due on an earlier day of this week that is still
 * ahead, which the one-step-a-day week put later (post-UAT FX1: «أروح
 * عالسوق», due tomorrow, was offered the day after as «من يوم فات»).
 */
export type WeekStepReason = 'due' | 'due_earlier' | 'carried' | 'open' | 'moved';

interface ProposedDay {
  readonly kind: 'proposed';
  readonly date: string;
  /** Floating work the daily rule puts on this day, before the week decides. */
  readonly rule: readonly string[];
  readonly constraints: PlanningConstraints;
  readonly plan: Plan;
  readonly assignment: DayAssignment;
  readonly reasons: ReadonlyMap<string, WeekStepReason>;
}

interface StoredDay {
  readonly kind: 'stored';
  readonly date: string;
  readonly rule: readonly string[];
  readonly stored: StoredDailyPlan;
}

export type WeekDay = ProposedDay | StoredDay;

export interface WeekLayout {
  readonly today: string;
  readonly timezone: string;
  readonly days: readonly WeekDay[];
  /** The decisions that applied, after the ones about nothing were ignored. */
  readonly decisions: WeekDecisions;
  /** Floating work that belongs to a day of this week and is placed on none. */
  readonly waiting: readonly string[];
  readonly commitments: readonly Commitment[];
  /**
   * Where the week puts each piece of work it holds on one day: the floating
   * work it placed, and the commitments pinned to a time still ahead, on the
   * local date of that time.
   */
  readonly placedOn: ReadonlyMap<string, string>;
}

/** The floating work the daily rule puts on `date`: `buildDailyPlanInput`'s own filter. */
function dailyRuleFor(uid: string, date: string, timezone: string, commitments: readonly Commitment[], builtAt: string): string[] {
  return buildDailyPlanInput({
    uid,
    date,
    timezone,
    commitments,
    // Which work is on the day reads neither busy time nor the routine.
    busyBlocks: [],
    profile: null,
    focusHint: null,
    builtAt,
  }).constraints.items.map((item) => item.itemId);
}

function reasonFor(
  commitment: Commitment | undefined,
  horizon: { startsAt: string; endsAt: string },
  todayStartsAt: string,
): WeekStepReason {
  const dueAt = commitment?.timeSpec.dueAt ?? null;
  if (!dueAt) return 'open';
  if (toEpochMs(dueAt) >= toEpochMs(horizon.startsAt)) return 'due';
  return toEpochMs(dueAt) < toEpochMs(todayStartsAt) ? 'carried' : 'due_earlier';
}

/**
 * The week as it stands for this account now, with the person's decisions
 * applied. Reads only; writes nothing.
 */
export async function composeWeek(
  uid: string,
  decisions: WeekDecisions,
  deps: DailyPlanDeps = {},
): Promise<WeekLayout> {
  const storage: StorageAdapter = deps.storage ?? getStorage();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  // Everything that does not depend on the date is read once for the week
  // (I5): the account document (its settings and routine with it), the
  // commitments and the kept focus window. Seven dates used to read them
  // seven times over, on every move.
  const user = await storage.get<Record<string, unknown> & { timezone?: string | null }>(userDoc(uid));
  const settings = planSettingsOf(user as Parameters<typeof planSettingsOf>[0], user?.timezone ?? DEFAULT_MOBILE_TIMEZONE);
  const timezone = settings.timezone;
  const today = localDateOf(nowIso, timezone);
  const dates = planDatesFrom(today, PLAN_PROPOSAL_DAYS);

  const preloaded = await preloadDailyPlanRequest(uid, nowIso, user, storage);
  const commitments = preloaded.commitments;
  const byId = new Map(commitments.map((commitment) => [commitment.id, commitment]));
  const storedByDate = new Map<string, StoredDailyPlan>();
  for (const date of dates) {
    const stored = await readStoredPlan(uid, date, storage);
    if (stored) storedByDate.set(date, stored);
  }
  const rules = new Map(dates.map((date) => [date, dailyRuleFor(uid, date, timezone, commitments, nowIso)]));
  // A commitment pinned to a time still ahead happens at that time: it is a
  // fixed row on its own day. Planning a later day on its own, the daily rule
  // reads it as yesterday's unfinished work (#383) — true on that morning if
  // it is still open, but not something to propose for it today.
  const pinnedAhead = new Map(commitments.flatMap((commitment) => {
    const start = fixedStartOf(commitment);
    return start !== null && toEpochMs(start) >= toEpochMs(nowIso) ? [[commitment.id, localDateOf(start, timezone)] as const] : [];
  }));

  // Work a stored plan of this week already places is that day's, whatever
  // its status — except a plan the person dismissed, which places nothing —
  // and a commitment pinned to a time ahead is its own day's.
  const placedOn = new Map<string, string>(Array.from(pinnedAhead));
  for (const [date, stored] of Array.from(storedByDate)) {
    if (stored.status === 'dismissed') continue;
    for (const item of effectiveSchedule(stored)) placedOn.set(item.itemId, date);
  }

  // Decisions apply only to floating work this week holds and has not stored,
  // and a move only onto a day that is still a proposal.
  const inWeek = new Set(Array.from(rules.values()).flat());
  const movable = (itemId: string): boolean => inWeek.has(itemId) && !placedOn.has(itemId);
  const drops = Array.from(new Set(decisions.drops.filter(movable)));
  const dropped = new Set(drops);
  const movedTo = new Map<string, string>();
  for (const move of decisions.moves) {
    if (!movable(move.itemId) || dropped.has(move.itemId)) continue;
    if (!rules.has(move.date) || storedByDate.has(move.date)) continue;
    movedTo.delete(move.itemId); // the last move of an item is the one that stands
    movedTo.set(move.itemId, move.date);
  }

  const days: WeekDay[] = [];
  for (const date of dates) {
    const rule = rules.get(date)!;
    const stored = storedByDate.get(date);
    if (stored) {
      days.push({ kind: 'stored', date, rule, stored });
      continue;
    }

    const forced = Array.from(movedTo).filter(([, to]) => to === date).map(([itemId]) => itemId);
    const pool = rule.filter((itemId) => !placedOn.has(itemId) && !dropped.has(itemId) && !movedTo.has(itemId));
    const candidates = new Set([...pool, ...forced]);
    const request = await composeDailyPlanRequest({
      uid,
      date,
      timezone,
      now: nowIso,
      userDocument: user,
      previousBlocks: null,
      assignment: { include: Array.from(candidates), exclude: rule.filter((itemId) => !candidates.has(itemId)) },
    }, { storage, preloaded, ...(deps.busyBlocks ? { busyBlocks: deps.busyBlocks } : {}) });

    // The planner's own first placement among the day's candidates is the step.
    const poolSet = new Set(pool);
    const step = [...schedulePlan(request.constraints, request.config).scheduled]
      .sort((left, right) => toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt))
      .find((item) => poolSet.has(item.itemId)) ?? null;

    const final = [...(step ? [step.itemId] : []), ...forced];
    const finalSet = new Set(final);
    // The request an acceptance composes (`assignment` below) holds exactly
    // these items; every other part of it is this request's.
    const constraints: PlanningConstraints = {
      ...request.constraints,
      items: request.constraints.items.filter((item) => finalSet.has(item.itemId)),
    };
    const plan = schedulePlan(constraints, request.config);
    const horizon = dayHorizon(date, timezone);
    const reasons = new Map<string, WeekStepReason>(forced.map((itemId) => [itemId, 'moved']));
    if (step) {
      reasons.set(step.itemId, reasonFor(byId.get(step.itemId), horizon, dayHorizon(today, timezone).startsAt));
      placedOn.set(step.itemId, date);
    }
    for (const itemId of forced) placedOn.set(itemId, date);
    days.push({
      kind: 'proposed',
      date,
      rule,
      constraints,
      plan,
      assignment: { include: final, exclude: rule.filter((itemId) => !finalSet.has(itemId)) },
      reasons,
    });
  }

  const waiting = Array.from(inWeek).filter((itemId) => !placedOn.has(itemId) && !dropped.has(itemId));
  return {
    today,
    timezone,
    days,
    decisions: { moves: Array.from(movedTo).map(([itemId, date]) => ({ itemId, date })), drops },
    waiting,
    commitments,
    placedOn,
  };
}

/* ── What the client reads ─────────────────────────────────────────── */

export interface WeekItemDto {
  readonly itemId: string;
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  /** Why a proposed step is on its day; null on a stored day's rows. */
  readonly reason: WeekStepReason | null;
}

export interface WeekRowDto {
  readonly itemId: string;
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
}

export interface WeekDayDto {
  readonly date: string;
  /**
   * `proposed`: a suggestion, nothing stored. `planned`: the date has a plan
   * the person has not accepted (built by the morning or on the plan screen).
   * `accepted`: the date's plan is accepted.
   */
  readonly state: 'proposed' | 'planned' | 'accepted';
  /** The day's floating work, in time order: the step, or the plan's rows. */
  readonly items: readonly WeekItemDto[];
  /** Commitments pinned to a time on the day (L5): fixed, never moved. */
  readonly fixed: readonly WeekRowDto[];
  /** Work the person moved here that does not fit the day. Proposed days only. */
  readonly unplaced: readonly { readonly itemId: string; readonly title: string | null }[];
}

export interface WeekDto {
  readonly today: string;
  readonly timezone: string;
  readonly days: readonly WeekDayDto[];
  readonly moves: readonly WeekMove[];
  readonly drops: readonly { readonly itemId: string; readonly title: string | null }[];
  /** How much of the week's floating work no day holds: it waits for later. */
  readonly waiting: number;
}

export function weekToDto(layout: WeekLayout): WeekDto {
  const titles = titlesOf(layout.commitments);
  const title = (itemId: string): string | null => titles.get(itemId) ?? null;
  return {
    today: layout.today,
    timezone: layout.timezone,
    days: layout.days.map((day): WeekDayDto => {
      if (day.kind === 'stored') {
        const dto = planToDto(day.stored, titles, { commitments: layout.commitments });
        return {
          date: day.date,
          state: day.stored.status === 'accepted' ? 'accepted' : 'planned',
          items: dto.scheduled.map((row) => ({ itemId: row.itemId, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt, reason: null })),
          fixed: dto.fixed.map((row) => ({ itemId: row.itemId, title: row.title, startsAt: row.startsAt, endsAt: row.endsAt })),
          unplaced: [],
        };
      }
      const fixed = pinnedEventsOnDay(day.constraints.fixedEvents, day.constraints.horizon)
        .flatMap((event) => event.sourceCommitmentId === null ? [] : [{
          itemId: event.sourceCommitmentId,
          title: title(event.sourceCommitmentId),
          startsAt: event.interval.startsAt,
          endsAt: event.interval.endsAt,
        }])
        .sort((left, right) => toEpochMs(left.startsAt) - toEpochMs(right.startsAt));
      return {
        date: day.date,
        state: 'proposed',
        items: [...day.plan.scheduled]
          .sort((left, right) => toEpochMs(left.interval.startsAt) - toEpochMs(right.interval.startsAt))
          .map((item) => ({
            itemId: item.itemId,
            title: title(item.itemId),
            startsAt: item.interval.startsAt,
            endsAt: item.interval.endsAt,
            reason: day.reasons.get(item.itemId) ?? null,
          })),
        fixed,
        unplaced: day.plan.unscheduled.map((item) => ({ itemId: item.itemId, title: title(item.itemId) })),
      };
    }),
    moves: layout.decisions.moves,
    drops: layout.decisions.drops.map((itemId) => ({ itemId, title: title(itemId) })),
    waiting: layout.waiting.length,
  };
}

/* ── Accepting one day ─────────────────────────────────────────────── */

export type WeekAcceptOutcome =
  | { readonly outcome: 'accepted'; readonly stored: StoredDailyPlan; readonly layout: WeekLayout }
  /** The date has a plan already; it is returned untouched. */
  | { readonly outcome: 'already_planned'; readonly stored: StoredDailyPlan; readonly layout: WeekLayout }
  /**
   * The day is not the day the card showed (I1): the account changed since
   * the person looked, or the plan was gone by the time it was accepted (M-a).
   * Nothing was accepted; `layout` is the week as it is now, to redraw.
   */
  | { readonly outcome: 'week_changed'; readonly layout: WeekLayout };

/** Whether the proposed day holds exactly the steps its card showed. Order does not matter. */
function sameSteps(day: ProposedDay, shown: readonly string[]): boolean {
  const onDay = new Set(day.assignment.include);
  const seen = new Set(shown);
  return onDay.size === seen.size && Array.from(seen).every((itemId) => onDay.has(itemId));
}

/**
 * Stores and accepts one day of the week as proposed under `decisions`.
 *
 * `shown` is the steps the day's card showed. The week is composed again
 * here, from the account as it is now; if that day's steps are not exactly
 * `shown`, nothing is stored and the answer is `week_changed` with the fresh
 * week (I1). The person confirmed a card, and only that card may be saved.
 *
 * Throws `PlanDateOutOfRangeError` for a date outside today … today+6, before
 * anything is written. The answer carries the week as it stands after, so the
 * client redraws from one response.
 */
export async function acceptWeekDay(
  uid: string,
  date: string,
  decisions: WeekDecisions,
  shown: readonly string[],
  deps: DailyPlanDeps = {},
): Promise<WeekAcceptOutcome> {
  const storage = deps.storage ?? getStorage();
  const layout = await composeWeek(uid, decisions, { ...deps, storage });
  const day = layout.days.find((candidate) => candidate.date === date);
  if (!day) throw new PlanDateOutOfRangeError(date, PLAN_PROPOSAL_DAYS);
  if (day.kind === 'stored') return { outcome: 'already_planned', stored: day.stored, layout };
  if (!sameSteps(day, shown)) return { outcome: 'week_changed', layout };

  const onThisDay = new Set(day.assignment.include);
  const origin: WeekPlanOrigin = {
    considered: [...day.rule],
    heldElsewhere: day.rule.flatMap((itemId) => {
      const elsewhere = layout.placedOn.get(itemId);
      return !onThisDay.has(itemId) && elsewhere !== undefined && elsewhere !== date ? [{ itemId, date: elsewhere }] : [];
    }),
    // Today's plan is on screen as it is accepted; the morning has nothing to announce.
    announced: date === layout.today,
  };

  const { created, stored } = await storeWeekDayPlan(uid, date, { assignment: day.assignment, origin }, { ...deps, storage });
  if (!created) {
    return { outcome: 'already_planned', stored, layout: await composeWeek(uid, decisions, { ...deps, storage }) };
  }
  const accepted = await acceptPlan(uid, date, { storage, ...(deps.now ? { now: deps.now } : {}) });
  const after = await composeWeek(uid, decisions, { ...deps, storage });
  // No plan to accept by the time the accept ran (M-a): the document went
  // between the store and the accept. Never answered as accepted.
  if (!accepted) return { outcome: 'week_changed', layout: after };
  return { outcome: 'accepted', stored: accepted, layout: after };
}

/* ── The saved week, for the Calendar strip (I4) ───────────────────── */

export interface SavedWeekDayDto {
  readonly date: string;
  /** The steps the saved day holds, at the times it holds them. */
  readonly items: readonly { readonly itemId: string; readonly startsAt: string; readonly endsAt: string }[];
}

export interface SavedWeekDto {
  readonly today: string;
  /** Days of today … today+6 the person saved from the week view, in date order. */
  readonly saved: readonly SavedWeekDayDto[];
}

/**
 * The days of the next seven the person saved from the week view, and what
 * each holds: what the Calendar's strip draws on each saved date, instead of
 * the step's due date or today. Reads only: the account document and the
 * seven plan documents. A dismissed day, or a plan built on its own, is not a
 * saved week day.
 */
export async function readSavedWeek(uid: string, deps: Pick<DailyPlanDeps, 'storage' | 'now'> = {}): Promise<SavedWeekDto> {
  const storage = deps.storage ?? getStorage();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const user = await storage.get<Record<string, unknown> & { timezone?: string | null }>(userDoc(uid));
  const settings = planSettingsOf(user as Parameters<typeof planSettingsOf>[0], user?.timezone ?? DEFAULT_MOBILE_TIMEZONE);
  const today = localDateOf(nowIso, settings.timezone);
  const saved: SavedWeekDayDto[] = [];
  for (const date of planDatesFrom(today, PLAN_PROPOSAL_DAYS)) {
    const stored = await readStoredPlan(uid, date, storage);
    if (!stored) continue;
    const held = new Set(heldBySavedWeekDay(stored));
    if (held.size === 0) continue;
    saved.push({
      date,
      items: effectiveSchedule(stored)
        .filter((item) => held.has(item.itemId))
        .map((item) => ({ itemId: item.itemId, startsAt: item.interval.startsAt, endsAt: item.interval.endsAt })),
    });
  }
  return { today, saved };
}

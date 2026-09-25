/**
 * A stored plan that no longer describes the day, and what reading it does
 * about that (L5, the owner's first-run repro).
 *
 * ── The defect ─────────────────────────────────────────────────────
 *
 * A fresh account opened the plan screen, got an empty plan (nothing was
 * captured yet), captured a few commitments, and came back to the same empty
 * plan. A stored plan was answered as stored: `buildDailyPlanOnDemand` returned
 * it untouched and `GET` read it back. The ways out were a rebuild the person
 * had to know to ask for, capped per day, or a replan proposal — and a capture
 * writes no `planningStateChanges` row, so the replan tick never hears of one.
 *
 * ── What counts as stale ───────────────────────────────────────────
 *
 * The digest the plan already carries is reused, not a second hashing scheme:
 * `planningInputDigest` taken over the part of the request the day's
 * commitments decide — which of them are in the day, their deadlines and
 * priorities, and the times the pinned ones hold — on both sides: the request
 * stored with the plan and the one the commitments produce now.
 *
 * Everything else is held equal on purpose:
 *
 *  - **the clock floor** (`earliestStartAt`) moves every fifteen minutes by
 *    itself (#500), so a full-request digest would call every plan stale all
 *    day long;
 *  - **titles** are joined at read time (`planToDto`), so a rename changes no
 *    placement;
 *  - **busy time** has its own producer (#611): a calendar write announces
 *    itself to the replan tick, whose rules for a changed day are #523's;
 *  - **buffers and protections** are plan-layer projections of state the
 *    person set elsewhere, not of the commitments.
 *
 * The comparison needs only the commitments, which the route has already
 * loaded, so a plan that is not stale costs its reader no other read.
 *
 * ── What reading a stale plan does ─────────────────────────────────
 *
 * If the person has not touched it — still `proposed`, never accepted, no
 * move, no removal, no protection — the plan is rebuilt from what the day holds
 * now, as the next generation. The whole request is composed afresh
 * (`composeDailyPlanRequest`, the builder the morning build and the replan
 * share), so the new plan sees the current calendar and routine as well.
 *
 * If the person has touched it, it is **never** overwritten (#626: automatic
 * replanning never overwrites an edited, dismissed or accepted plan). It is
 * returned as it is with `inputsChanged: true`, and the screen offers the
 * rebuild — the person's own decision, on the cap they already have.
 *
 * Only today's and tomorrow's plans are refreshed, the two dates a plan can be
 * built for (`PlanDateOutOfRangeError`). A past day's plan is a record.
 *
 * ── What the refresh costs, and what it does not ────────────────────
 *
 * No model call: the explanation is the deterministic template the automatic
 * replan writes (`replanExplanation`, #586). A reader waiting on `GET` must not
 * wait on Gemini, and a capture-by-capture morning must not spend a model call
 * per capture.
 *
 * No rebuild: the new generation is counted in `automaticGenerations`, which
 * the cap subtracts (`userGenerationsOf`).
 *
 * ── The write ──────────────────────────────────────────────────────
 *
 * One transaction, built from the document it reads and refused unless that
 * document is still the untouched state the refresh judged — the same guard
 * shape the automatic replan uses (#610), because an accept, an edit or a
 * protection can land between the read and the write, and none of them moves
 * the generation. The `plan_regenerated` ledger entry commits with it, without
 * `causeChangeIds`: no monitor caused this, and an empty list would be a claim.
 */
import { isDeepStrictEqual } from 'node:util';
import { getStorage, type StorageAdapter } from '../../storage';
import { userDoc } from '../../storage/paths';
import {
  planningInputDigest,
  protectionOf,
  reconcileScheduleBlocks,
  schedulePlan,
} from '../../planning/scheduler';
import type { FixedEvent, PlanningConstraints, PlanningItem } from '../../../src/contracts/v1/planningContracts';
import { toEpochMs } from '../../planning/shared/time';
import type { Commitment } from '../../../src/domain/stateMachine';
import { loadDomainState } from '../mobile/participantState';
import { buildDailyPlanInput, dailyPlanScheduleSources, pinnedEventsOnDay, type BusyBlockReader } from './buildDailyPlan';
import { composeDailyPlanRequest } from './dailyPlanService';
import {
  NO_EDITS,
  mutateStoredPlan,
  pendingProposalOf,
  preparePlanEvent,
  readStoredPlan,
  type StoredDailyPlan,
} from './planStore';
import { localDateOf } from './planSettings';
import { replanExplanation } from './replanMetadata';

export interface PlanRefreshDeps {
  readonly storage?: StorageAdapter;
  readonly now?: () => Date;
  readonly busyBlocks?: BusyBlockReader;
  /** The account's commitments, for a caller that has already loaded them. */
  readonly commitments?: readonly Commitment[];
}

/** A plan as a reader should see it now. */
export interface CurrentPlan {
  readonly stored: StoredDailyPlan;
  /**
   * Something landed on this plan's day since it was built — a commitment
   * added to the day, or one whose time moved into or within it — and the plan
   * was not rebuilt because the person has touched it. A commitment completed,
   * deleted or moved off the day does not raise it: the plan's rows already
   * show it gone, and "something new" would be false. False for a plan that
   * is current, including one this read just refreshed.
   */
  readonly inputsChanged: boolean;
}

/**
 * Whether the person has done anything to this plan: accepted or dismissed
 * it, moved or removed something, protected a block, or answered a replan
 * offer on it (`proposalAnswered` for an acceptance, `rejectedProposals` for
 * a decline) — or an offer is waiting for their answer (#587, #611). Any one
 * of them makes the plan theirs, and an automatic write must not replace it:
 * a rebuild composes the whole current request, so it would install the
 * calendar move a declined offer proposed, drop the marks that keep it from
 * being offered again, undo a placement the person accepted, or discard an
 * offer they have not seen.
 */
export function planIsUntouched(stored: StoredDailyPlan, now: Date): boolean {
  return stored.status === 'proposed'
    && stored.acceptedAt === null
    && stored.edits.moves.length === 0
    && stored.edits.removals.length === 0
    && (stored.blocks ?? []).every((block) => protectionOf(block) === null)
    && stored.proposalAnswered !== true
    && (stored.rejectedProposals ?? []).length === 0
    && pendingProposalOf(stored, now) === null;
}

/** An item as the day's commitments decide it; see the header for what is held equal. */
function commitmentShapeOf(item: PlanningItem): PlanningItem {
  return {
    itemId: item.itemId,
    title: '',
    effort: item.effort,
    earliestStartAt: null,
    deadlineAt: item.deadlineAt,
    priority: item.priority,
    dependsOn: item.dependsOn,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
  };
}

/**
 * The pinned commitments on the plan's own day. Busy time is the replan
 * tick's (#611), and a commitment pinned to another day blocks nothing on this
 * one: counting next week's dentist made every timed capture rebuild today.
 */
function pinnedEventsOf(frame: StoredDailyPlan, events: readonly FixedEvent[]): FixedEvent[] {
  return pinnedEventsOnDay(events, frame.constraints.horizon);
}

/**
 * The digest of the part of a request the commitments decide, framed by the
 * stored plan (scope, zone, horizon, config) so that nothing else can differ.
 */
function commitmentDigest(frame: StoredDailyPlan, constraints: PlanningConstraints): string {
  return planningInputDigest({
    ...frame.constraints,
    workingWindows: [],
    fixedEvents: pinnedEventsOf(frame, constraints.fixedEvents),
    items: constraints.items.map(commitmentShapeOf),
  }, frame.config);
}

/** The request the day's commitments produce now, for the comparisons below. */
function currentRequestOf(uid: string, stored: StoredDailyPlan, commitments: readonly Commitment[]): PlanningConstraints {
  return buildDailyPlanInput({
    uid,
    date: stored.date,
    timezone: stored.timezone,
    commitments,
    // Only the pinned commitments and the items are compared, and neither
    // reads the busy time, the routine or the clock.
    busyBlocks: [],
    profile: null,
    focusHint: null,
    builtAt: stored.generatedAt,
  }).constraints;
}

/**
 * Whether the day's commitments say something different now from what this
 * plan was built from. Pure: it takes the commitments rather than reading them.
 */
export function planInputsChanged(
  uid: string,
  stored: StoredDailyPlan,
  commitments: readonly Commitment[],
): boolean {
  const current = currentRequestOf(uid, stored, commitments);
  return commitmentDigest(stored, current) !== commitmentDigest(stored, stored.constraints);
}

/**
 * Whether something *landed* on the day since the plan was built: a
 * commitment that is on the day now and was not (added, or moved onto it, or
 * turned from floating into pinned or back), or one whose time on the day
 * moved (a new deadline, a new pinned interval).
 *
 * Removals are deliberately not an answer here. Completing, deleting or
 * snoozing a commitment off the day changes the digest, but the plan already
 * shows it gone, and telling the person something new arrived — and nudging
 * them to spend a capped rebuild on it — would be false. Priority is not a
 * time. This is what `inputsChanged` means on a plan the person has touched.
 */
export function dayGainedOrMoved(
  uid: string,
  stored: StoredDailyPlan,
  commitments: readonly Commitment[],
): boolean {
  const current = currentRequestOf(uid, stored, commitments);
  const floatingBefore = new Map(stored.constraints.items.map((item) => [item.itemId, item.deadlineAt] as const));
  for (const item of current.items) {
    if (!floatingBefore.has(item.itemId)) return true;
    const before = floatingBefore.get(item.itemId) ?? null;
    const after = item.deadlineAt ?? null;
    if ((before === null) !== (after === null)) return true;
    if (before !== null && after !== null && toEpochMs(before) !== toEpochMs(after)) return true;
  }
  const pinnedBefore = new Map(pinnedEventsOf(stored, stored.constraints.fixedEvents)
    .map((event) => [event.sourceCommitmentId, event.interval] as const));
  for (const event of pinnedEventsOf(stored, current.fixedEvents)) {
    const before = pinnedBefore.get(event.sourceCommitmentId);
    if (before === undefined) return true;
    if (toEpochMs(before.startsAt) !== toEpochMs(event.interval.startsAt)
      || toEpochMs(before.endsAt) !== toEpochMs(event.interval.endsAt)) return true;
  }
  return false;
}

/** The calendar date after a `YYYY-MM-DD`. Civil arithmetic, no zone. */
function nextCivilDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** Today or tomorrow in the plan's own zone: the dates a plan can be built for. */
function isRefreshableDate(stored: StoredDailyPlan, now: Date): boolean {
  const today = localDateOf(now.toISOString(), stored.timezone);
  return stored.date === today || stored.date === nextCivilDate(today);
}

/** The untouched state the refresh judged, still in force. See the header. */
function stillTheStateJudged(current: StoredDailyPlan, judged: StoredDailyPlan): boolean {
  return current.generation === judged.generation
    && current.inputDigest === judged.inputDigest
    && current.status === judged.status
    && current.acceptedAt === judged.acceptedAt
    && isDeepStrictEqual(current.edits, judged.edits)
    && isDeepStrictEqual(current.blocks ?? [], judged.blocks ?? [])
    && (current.proposal?.proposalId ?? null) === (judged.proposal?.proposalId ?? null)
    && current.proposalAnswered === judged.proposalAnswered
    && (current.rejectedProposals ?? []).length === (judged.rejectedProposals ?? []).length;
}

/**
 * The plan as a reader should see it: rebuilt if it is stale and untouched,
 * flagged if it is stale and touched, and as stored otherwise.
 */
export async function refreshStalePlan(
  uid: string,
  stored: StoredDailyPlan,
  deps: PlanRefreshDeps = {},
): Promise<CurrentPlan> {
  const storage = deps.storage ?? getStorage();
  const now = (deps.now ?? (() => new Date()))();
  if (!isRefreshableDate(stored, now)) return { stored, inputsChanged: false };

  const commitments = deps.commitments ?? Object.values((await loadDomainState(storage, uid)).commitments);
  if (!planInputsChanged(uid, stored, commitments)) return { stored, inputsChanged: false };
  if (!planIsUntouched(stored, now)) {
    return { stored, inputsChanged: dayGainedOrMoved(uid, stored, commitments) };
  }

  const nowIso = now.toISOString();
  const user = await storage.get<Record<string, unknown>>(userDoc(uid));
  const { constraints, config } = await composeDailyPlanRequest({
    uid,
    date: stored.date,
    timezone: stored.timezone,
    now: nowIso,
    userDocument: user,
    previousBlocks: stored.blocks ?? [],
  }, { storage, ...(deps.busyBlocks ? { busyBlocks: deps.busyBlocks } : {}) });
  const plan = schedulePlan(constraints, config);

  const written = await mutateStoredPlan<null>(uid, stored.date, (current) => {
    if (!stillTheStateJudged(current, stored)) return null;
    const generation = current.generation + 1;
    const next: StoredDailyPlan = {
      date: current.date,
      timezone: current.timezone,
      locale: current.locale,
      status: 'proposed',
      plan,
      blocks: reconcileScheduleBlocks({
        constraints,
        plan,
        generation,
        sources: dailyPlanScheduleSources(constraints),
        previous: current.blocks ?? null,
      }),
      replaces: { generation: current.generation, inputDigest: current.inputDigest },
      constraints,
      config,
      incrementalSolve: null,
      explanation: replanExplanation(plan, current),
      edits: NO_EDITS,
      generatedAt: nowIso,
      generation,
      inputDigest: plan.inputDigest,
      acceptedAt: null,
      updatedAt: nowIso,
      // Assigned, not inherited: a patch of the generation being replaced
      // describes a plan that no longer exists.
      proposal: null,
      automaticGenerations: (current.automaticGenerations ?? 0) + 1,
    };
    return {
      next,
      result: null,
      ledger: [preparePlanEvent(uid, {
        type: 'plan_regenerated',
        date: current.date,
        at: nowIso,
        generation,
        inputDigest: plan.inputDigest,
      })],
    };
  }, storage);

  if (written !== null) return { stored: written.stored, inputsChanged: false };
  // The plan moved while this was solving: somebody touched it, or another
  // reader refreshed it first. Whatever is stored now is the answer, judged
  // again on the next read.
  const latest = await readStoredPlan(uid, stored.date, storage);
  return { stored: latest ?? stored, inputsChanged: false };
}

/** Reads a day's plan as `GET` answers it; null when there is none. */
export async function readCurrentPlan(
  uid: string,
  date: string,
  deps: PlanRefreshDeps = {},
): Promise<CurrentPlan | null> {
  const stored = await readStoredPlan(uid, date, deps.storage);
  if (!stored) return null;
  return refreshStalePlan(uid, stored, deps);
}

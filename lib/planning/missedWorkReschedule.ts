/**
 * A real new plan for missed work (spec 2026-11-12, Part 1 item 4; owner
 * answer of 2026-11-13, lane E4).
 *
 * ── What counts as missed ────────────────────────────────────────
 *
 * #383's rule: an `active` commitment whose time has passed and that nobody
 * finished. Of those, only *work given a time* is rescheduled here: a
 * `scheduled_event` that is a task and not an appointment (`isEventCommitment`
 * says which — appointments leave on their own, lane E1), or a work session
 * the goal plan placed (a `due_by` window with `windowRule: 'shift'`). A
 * deadline is not rescheduled — a missed deadline goes to «ما اتصرّفت فيها»
 * (lane E2) — and neither is anything all-day or without a time. It is missed
 * once its session has ended: start (`fixedStartOf`) plus its length.
 *
 * ── The proposal ─────────────────────────────────────────────────
 *
 * Deterministic, from the engines: busy time from every source the free-slot
 * engine reads (commitments, the phone's and Google's busy time, ICS feeds,
 * manual busy, weekly blocks, the routine's sleep window), the stored day
 * plans' placed items, and the approach `rescheduleApproach.ts` picks from the
 * miss history. No model is called; the phone words the line from templates.
 *
 * Reading a proposal writes nothing. Nothing changes until `accept`, which
 * moves the work through the existing domain commands (`Postpone` with the
 * verified interval, `UpdateCommitment`, and `CreateDraft`/`ConfirmCommitment`
 * for a second piece), behind the account fence (#772), at most once per
 * `clientActionId`, and with every session re-checked against busy time inside
 * the transaction. `undo` is open for 24 hours after.
 *
 * Behind `MAYBESITTER_FEATURE_MISSED_RESCHEDULE` (off by default), with its
 * kill switch, and never in production: the free-slot engine it reads is
 * itself release-locked to local, test and staging.
 */
import { createHash } from 'node:crypto';
import {
  applyCommand as applyDomainCommand,
  type Command,
  type Commitment,
  type DomainEvent,
  type DomainState,
  type TimeSpec,
} from '../../src/domain/stateMachine';
import { readRuntimeBoolean } from '../../src/contracts/v1/runtimeControls';
import { localTimeSpecFor } from '../../src/extraction/timeLexicon';
import { assertLiveAccount } from '../account/accountLiveness';
import { readActivityStats, recordActivityEvents } from '../services/activity/activityStats';
import { isEventCommitment } from '../services/commitments/eventEnded';
import { fixedStartOf } from '../services/dailyPlan/buildDailyPlan';
import { addCivilDays } from '../services/dailyPlan/dailyPlanService';
import { readStoredPlan } from '../services/dailyPlan/planStore';
import {
  ClientActionIdReusedError,
  COMMITMENT_ACTION_RECEIPT_TTL_MS,
  commitmentActionReceiptPath,
  loadDomainState,
  writeDomainDiff,
  type CommitmentActionReceipt,
} from '../services/mobile/participantState';
import { clockLengthOf } from '../services/timeCollision';
import { getStorage, type StorageAdapter } from '../storage';
import { RESCHEDULE_PROPOSALS, userCol, userDoc, userSubDoc } from '../storage/paths';
import type { UserDocument } from '../storage/userDocument';
import { candidateClashes, findFreeSlots, readFreeSlotSchedule, runScheduleDecisionHook, type FreeSlotSchedule } from './freeSlots';
import {
  chooseApproach,
  dayPartOf,
  minutesOf,
  pickSessions,
  withMiss,
  type DayPart,
  type Interval,
  type MissRecord,
  type RescheduleChange,
  type RescheduleReason,
} from './rescheduleApproach';

const HOUR = 3_600_000;
const MINUTE = 60_000;
export const UNDO_WINDOW_MS = 24 * HOUR;
/** How far ahead a new plan may go: today and the next seven days. */
const HORIZON_DAYS = 8;
/** How many missed items are tried for a proposal before the list gives up. */
const CANDIDATES_TRIED = 3;
/** Misses kept per commitment: enough to see a pattern, bounded. */
const MAX_MISSES = 12;

export function resolveMissedReschedule(env: Record<string, string | undefined> = process.env): boolean {
  const environment = (env.MAYBESITTER_ENV ?? 'local').trim().toLowerCase() || 'local';
  if (!['local', 'test', 'staging'].includes(environment)) return false;
  if (readRuntimeBoolean(env.MAYBESITTER_KILL_SWITCH_MISSED_RESCHEDULE, false)) return false;
  return readRuntimeBoolean(env.MAYBESITTER_FEATURE_MISSED_RESCHEDULE, false);
}

/* ── stored record ─────────────────────────────────────────────────── */

interface AcceptedPlan {
  acceptedAt: string;
  undoUntil: string;
  missedAt: string;
  /** The commitment's time before the plan, restored by undo. */
  before: { dueAt: string | null; endAt: string | null; remindAt: string | null; itemKind: TimeSpec['itemKind'] | null };
  sessions: Interval[];
  /** A second piece the plan added, removed by undo. */
  createdIds: string[];
  undoneAt: string | null;
}

export interface StoredReschedule {
  commitmentId: string;
  misses: MissRecord[];
  dismissedMissAt: string | null;
  accepted: AcceptedPlan | null;
  updatedAt: string;
}

function recordPath(uid: string, commitmentId: string): string {
  return userSubDoc(uid, RESCHEDULE_PROPOSALS, commitmentId);
}

/* ── missed work ───────────────────────────────────────────────────── */

function isWorkSession(row: Commitment): boolean {
  const spec = row.timeSpec;
  if (spec.allDay || !spec.dueAt) return false;
  if (spec.kind === 'scheduled_event') return !isEventCommitment(row);
  return spec.kind === 'due_by' && spec.windowRule === 'shift' && Boolean(spec.endAt);
}

/** When the missed session was meant to start, or null when `row` is not missed work at `now`. */
export function missedStartOf(row: Commitment, now: Date): string | null {
  if (row.status !== 'active' || !isWorkSession(row)) return null;
  const start = fixedStartOf(row);
  if (!start) return null;
  const end = Date.parse(start) + clockLengthOf(row) * MINUTE;
  return end <= now.getTime() ? start : null;
}

/* ── the proposal ──────────────────────────────────────────────────── */

export interface ProposalSession { startsAt: string; endsAt: string; localDate: string; localTime: string }

export interface RescheduleProposal {
  commitmentId: string;
  title: string;
  proposalId: string;
  missedAt: string;
  missCount: number;
  reason: RescheduleReason;
  changes: RescheduleChange[];
  fromDayPart: DayPart;
  toDayPart: DayPart;
  minutesBefore: number;
  minutesEach: number;
  sessions: ProposalSession[];
}

interface Computed { proposal: RescheduleProposal; version: string; current: MissRecord }

function versionOf(row: Commitment): string {
  return JSON.stringify({ status: row.status, updatedAt: row.updatedAt, timeSpec: row.timeSpec, postponedUntil: row.postponedUntil });
}

function proposalIdOf(row: Commitment, missedAt: string, sessions: readonly Interval[]): string {
  return createHash('sha256')
    .update(JSON.stringify({ id: row.id, version: versionOf(row), missedAt, sessions: sessions.map((s) => [s.startsAt, s.endsAt]) }))
    .digest('base64url')
    .slice(0, 32);
}

function sessionView(interval: Interval, timezone: string): ProposalSession {
  const local = localTimeSpecFor(new Date(interval.startsAt), timezone)!;
  return { startsAt: interval.startsAt, endsAt: interval.endsAt, localDate: local.date, localTime: local.time! };
}

async function planHolds(uid: string, ownId: string, dates: readonly string[], storage: StorageAdapter): Promise<Interval[]> {
  const plans = await Promise.all(dates.map((date) => readStoredPlan(uid, date, storage)));
  return plans.flatMap((plan) => (plan?.plan.scheduled ?? [])
    .filter((item) => item.itemId !== ownId)
    .map((item) => ({ startsAt: item.interval.startsAt, endsAt: item.interval.endsAt })));
}

async function compute(
  uid: string,
  row: Commitment,
  record: StoredReschedule | null,
  context: { timezone: string; now: Date; storage: StorageAdapter; schedule: FreeSlotSchedule; dates: string[]; holds: Interval[] },
): Promise<Computed | null> {
  const missedAt = missedStartOf(row, context.now);
  if (!missedAt) return null;
  if (record?.dismissedMissAt === missedAt) return null;
  const minutesBefore = clockLengthOf(row);
  const current: MissRecord = { startsAt: missedAt, durationMinutes: minutesBefore, dayPart: dayPartOf(missedAt, context.timezone) };
  const history = record?.misses ?? [];
  const approach = chooseApproach({ current, history, deadlineAt: null, now: context.now.toISOString() });
  const schedule = { ...context.schedule, commitments: context.schedule.commitments.filter((other) => other.id !== row.id) };
  const free = await findFreeSlots({
    policy: 'capture', uid, timezone: context.timezone, now: context.now.toISOString(), dates: context.dates,
    durationMinutes: approach.minutesEach, schedule, held: context.holds, limit: 1_000, minimumSeparationMinutes: 0,
    storage: context.storage,
  });
  const checked = free.filter((slot) => candidateClashes(schedule, { dueAt: slot.startsAt, endAt: slot.endsAt, kind: 'scheduled_event' },
    { excludeCommitmentIds: [row.id] }).state === 'free');
  const sessions = pickSessions(checked, approach, { timezone: context.timezone, deadlineAt: null });
  if (!sessions) return null;
  return {
    version: versionOf(row),
    current,
    proposal: {
      commitmentId: row.id,
      title: row.title,
      proposalId: proposalIdOf(row, missedAt, sessions),
      missedAt,
      missCount: approach.missCount,
      reason: approach.reason,
      changes: [...approach.changes],
      fromDayPart: current.dayPart,
      toDayPart: dayPartOf(sessions[0]!.startsAt, context.timezone),
      minutesBefore,
      minutesEach: minutesOf(sessions[0]!),
      sessions: sessions.map((session) => sessionView(session, context.timezone)),
    },
  };
}

interface ReadContext { state: DomainState; timezone: string; records: Map<string, StoredReschedule> }

async function readContext(uid: string, storage: StorageAdapter): Promise<ReadContext> {
  const [state, user, rows] = await Promise.all([
    loadDomainState(storage, uid),
    storage.get<UserDocument>(userDoc(uid)),
    storage.list<StoredReschedule>(userCol(uid, RESCHEDULE_PROPOSALS)),
  ]);
  return { state, timezone: user?.timezone || 'UTC', records: new Map(rows.map(({ data }) => [data.commitmentId, data])) };
}

async function computeFor(uid: string, rows: readonly Commitment[], context: ReadContext, now: Date, storage: StorageAdapter): Promise<Computed | null> {
  if (rows.length === 0) return null;
  const timezone = context.timezone !== 'UTC' ? context.timezone : rows[0]!.timeSpec.timezone || 'UTC';
  const today = localTimeSpecFor(now, timezone)?.date;
  if (!today) return null;
  const dates = Array.from({ length: HORIZON_DAYS }, (_, index) => addCivilDays(today, index));
  const window = { startsAt: now.toISOString(), endsAt: new Date(now.getTime() + (HORIZON_DAYS + 1) * 24 * HOUR).toISOString() };
  // An incomplete read is not "free": the free-slot engine and the clash check
  // both answer nothing for it, so there is no proposal rather than a guess.
  const schedule = await readFreeSlotSchedule(uid, window, storage, now.toISOString());
  for (const row of rows) {
    const holds = await planHolds(uid, row.id, dates, storage);
    const computed = await compute(uid, row, context.records.get(row.id) ?? null, { timezone, now, storage, schedule, dates, holds });
    if (computed) return computed;
  }
  return null;
}

export interface AcceptedView { commitmentId: string; title: string; undoUntil: string; sessions: ProposalSession[] }

function undoable(record: StoredReschedule, state: DomainState, now: Date): Commitment | null {
  const plan = record.accepted;
  if (!plan || plan.undoneAt || Date.parse(plan.undoUntil) <= now.getTime()) return null;
  const row = state.commitments[record.commitmentId];
  if (!row || row.status !== 'active' || fixedStartOf(row) !== plan.sessions[0]?.startsAt) return null;
  const piecesIntact = plan.createdIds.every((id) => state.commitments[id]?.status === 'active');
  return piecesIntact ? row : null;
}

/** Today's card: the newest missed work's proposal, and the plans that can still be undone. */
export async function listRescheduleProposals(
  uid: string,
  options: { storage?: StorageAdapter; now?: Date } = {},
): Promise<{ proposal: RescheduleProposal | null; accepted: AcceptedView[] }> {
  const storage = options.storage ?? getStorage();
  const now = options.now ?? new Date();
  const context = await readContext(uid, storage);
  const missed = Object.values(context.state.commitments)
    .map((row) => ({ row, missedAt: missedStartOf(row, now) }))
    .filter((entry): entry is { row: Commitment; missedAt: string } => entry.missedAt !== null
      && context.records.get(entry.row.id)?.dismissedMissAt !== entry.missedAt)
    .sort((a, b) => Date.parse(b.missedAt) - Date.parse(a.missedAt) || a.row.id.localeCompare(b.row.id))
    .slice(0, CANDIDATES_TRIED)
    .map((entry) => entry.row);
  const computed = await computeFor(uid, missed, context, now, storage);
  const accepted: AcceptedView[] = [];
  for (const record of Array.from(context.records.values())) {
    const row = undoable(record, context.state, now);
    if (!row || !record.accepted) continue;
    const timezone = context.timezone !== 'UTC' ? context.timezone : row.timeSpec.timezone || 'UTC';
    accepted.push({
      commitmentId: row.id, title: row.title, undoUntil: record.accepted.undoUntil,
      sessions: record.accepted.sessions.map((session) => sessionView(session, timezone)),
    });
  }
  accepted.sort((a, b) => Date.parse(b.undoUntil) - Date.parse(a.undoUntil) || a.commitmentId.localeCompare(b.commitmentId));
  return { proposal: computed?.proposal ?? null, accepted };
}

async function computeOne(uid: string, id: string, storage: StorageAdapter, now: Date): Promise<Computed | null> {
  const context = await readContext(uid, storage);
  const row = context.state.commitments[id];
  return row ? computeFor(uid, [row], context, now, storage) : null;
}

/* ── decisions ─────────────────────────────────────────────────────── */

export class RescheduleNotFoundError extends Error { constructor() { super('not_found'); } }
export class RescheduleStaleError extends Error { constructor(readonly fresh: RescheduleProposal | null) { super('proposal_stale'); } }
export class UndoUnavailableError extends Error { constructor() { super('undo_unavailable'); } }
export class NothingToDismissError extends Error { constructor() { super('nothing_to_dismiss'); } }

type Decision = 'accept' | 'dismiss' | 'undo';
export interface DecisionResult { state: 'accepted' | 'dismissed' | 'undone'; undoUntil?: string; replayed: boolean }

function emptyRecord(commitmentId: string, now: string): StoredReschedule {
  return { commitmentId, misses: [], dismissedMissAt: null, accepted: null, updatedAt: now };
}

function rememberMiss(misses: readonly MissRecord[], miss: MissRecord): MissRecord[] {
  return withMiss(misses, miss).slice(-MAX_MISSES);
}

/** The second piece's id: derived, so the same accepted plan names the same piece. */
function pieceId(commitmentId: string, missedAt: string, index: number): string {
  const hex = createHash('sha256').update(`${commitmentId}|${missedAt}|${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function applyAll(state: DomainState, commands: readonly Command[]): { state: DomainState; events: DomainEvent[] } {
  let current = state;
  const events: DomainEvent[] = [];
  for (const command of commands) {
    const transition = applyDomainCommand(current, command);
    current = transition.newState;
    events.push(...transition.events);
  }
  return { state: current, events };
}

function acceptCommands(row: Commitment, sessions: readonly Interval[], missedAt: string, now: string): { commands: Command[]; createdIds: string[] } {
  const spec = row.timeSpec;
  const first = sessions[0]!;
  const lengthChanged = minutesOf(first) !== clockLengthOf(row);
  // An end on a `scheduled_event` with no stored kind would read it as an
  // appointment (`isEventCommitment`), and an appointment that is over
  // leaves Today. Work given an end says it is work.
  const needsEnd = Boolean(spec.endAt) || lengthChanged;
  const commands: Command[] = [{
    type: 'Postpone', commitmentId: row.id, postponedUntil: first.startsAt, now,
    moveInterval: { dueAt: first.startsAt, endAt: needsEnd ? first.endsAt : null, remindAt: spec.remindAt ? first.startsAt : null },
  }];
  if (needsEnd && spec.kind === 'scheduled_event' && spec.itemKind !== 'task') {
    commands.push({ type: 'UpdateCommitment', commitmentId: row.id, now, updates: { timeSpec: { itemKind: 'task' } } });
  }
  const createdIds: string[] = [];
  sessions.slice(1).forEach((session, index) => {
    const id = pieceId(row.id, missedAt, index + 1);
    createdIds.push(id);
    commands.push({
      type: 'CreateDraft', now,
      commitment: {
        id, kind: row.kind, title: row.title, description: row.description, person: row.person,
        priority: row.priority, category: row.category,
        timeSpec: {
          kind: spec.kind, dueAt: session.startsAt, endAt: session.endsAt, remindAt: session.startsAt, allDay: false, timezone: spec.timezone,
          ...(spec.windowRule === 'shift' ? { windowRule: 'shift' as const } : {}),
          ...(spec.kind === 'scheduled_event' ? { itemKind: 'task' as const } : {}),
        },
      },
    }, { type: 'ConfirmCommitment', commitmentId: id, now });
  });
  return { commands, createdIds };
}

function receiptFingerprint(action: Decision, proposalId: string | undefined): string {
  return `reschedule|${action}|${proposalId ?? ''}`;
}

async function decide(
  uid: string,
  id: string,
  action: Decision,
  input: { clientActionId: string; proposalId?: string; storage?: StorageAdapter; now?: Date },
): Promise<DecisionResult> {
  const storage = input.storage ?? getStorage();
  const now = input.now ?? new Date();
  const at = now.toISOString();
  const fingerprint = receiptFingerprint(action, input.proposalId);
  const receiptPath = commitmentActionReceiptPath(uid, input.clientActionId);

  const replayOf = (receipt: CommitmentActionReceipt | null, record: StoredReschedule | null): DecisionResult | null => {
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.commitmentId !== id) throw new ClientActionIdReusedError();
    const state = action === 'accept' ? 'accepted' : action === 'dismiss' ? 'dismissed' : 'undone';
    return { state, ...(action === 'accept' && record?.accepted ? { undoUntil: record.accepted.undoUntil } : {}), replayed: true };
  };

  // A delivered tap answered again: before recomputing, because the work has
  // moved and the proposal it accepted is no longer the one on offer.
  const early = replayOf(await storage.get<CommitmentActionReceipt>(receiptPath), await storage.get<StoredReschedule>(recordPath(uid, id)));
  if (early) return early;

  const computed = action === 'undo' ? null : await computeOne(uid, id, storage, now);
  if (action === 'accept' && (!computed || computed.proposal.proposalId !== input.proposalId)) {
    const exists = (await loadDomainState(storage, uid)).commitments[id];
    if (!exists) throw new RescheduleNotFoundError();
    throw new RescheduleStaleError(computed?.proposal ?? null);
  }

  let result: DecisionResult = { state: 'dismissed', replayed: false };
  await storage.runTransaction(async (tx) => {
    // The account deletion fence (#772), first.
    const user = await tx.get<UserDocument>(userDoc(uid));
    assertLiveAccount(user);
    const [receipt, stored] = await Promise.all([
      tx.get<CommitmentActionReceipt>(receiptPath),
      tx.get<StoredReschedule>(recordPath(uid, id)),
    ]);
    const replay = replayOf(receipt, stored);
    if (replay) { result = replay; return; }
    const [state, stats] = await Promise.all([loadDomainState(tx, uid), readActivityStats(tx, uid)]);
    const row = state.commitments[id];
    if (!row) throw new RescheduleNotFoundError();
    const record = stored ?? emptyRecord(id, at);
    let next: StoredReschedule;
    let transition: { state: DomainState; events: DomainEvent[] } | null = null;

    if (action === 'undo') {
      const plan = record.accepted;
      if (!plan || !undoable(record, state, now)) throw new UndoUnavailableError();
      const commands: Command[] = plan.createdIds.map((pieceIdValue) => ({ type: 'Delete', commitmentId: pieceIdValue, now: at }));
      if (row.postponedUntil) commands.push({ type: 'MarkAware', commitmentId: id, now: at });
      commands.push({
        type: 'UpdateCommitment', commitmentId: id, now: at,
        updates: { timeSpec: {
          dueAt: plan.before.dueAt, endAt: plan.before.endAt,
          // A reminder already in the past is not put back to ring at once.
          remindAt: plan.before.remindAt && Date.parse(plan.before.remindAt) > now.getTime() ? plan.before.remindAt : null,
          itemKind: plan.before.itemKind ?? undefined,
        } },
      });
      transition = applyAll(state, commands);
      next = { ...record, dismissedMissAt: plan.missedAt, accepted: { ...plan, undoneAt: at }, updatedAt: at };
      result = { state: 'undone', replayed: false };
    } else {
      if (!computed) {
        if (action === 'dismiss') throw new NothingToDismissError();
        throw new RescheduleStaleError(null);
      }
      if (versionOf(row) !== computed.version) throw new RescheduleStaleError(null);
      const misses = rememberMiss(record.misses, computed.current);
      if (action === 'dismiss') {
        next = { ...record, misses, dismissedMissAt: computed.proposal.missedAt, updatedAt: at };
        result = { state: 'dismissed', replayed: false };
      } else {
        const sessions = computed.proposal.sessions.map(({ startsAt, endsAt }) => ({ startsAt, endsAt }));
        const window = { startsAt: sessions[0]!.startsAt, endsAt: sessions[sessions.length - 1]!.endsAt };
        const schedule = await readFreeSlotSchedule(uid, window, tx as unknown as StorageAdapter, at);
        await runScheduleDecisionHook('reschedule');
        for (const session of sessions) {
          const clash = candidateClashes(schedule, { dueAt: session.startsAt, endAt: session.endsAt, kind: 'scheduled_event' }, { excludeCommitmentIds: [id] });
          if (clash.state !== 'free') throw new RescheduleStaleError(null);
        }
        const { commands, createdIds } = acceptCommands(row, sessions, computed.proposal.missedAt, at);
        transition = applyAll(state, commands);
        const undoUntil = new Date(now.getTime() + UNDO_WINDOW_MS).toISOString();
        next = {
          ...record, misses, updatedAt: at,
          accepted: {
            acceptedAt: at, undoUntil, missedAt: computed.proposal.missedAt,
            before: { dueAt: row.timeSpec.dueAt, endAt: row.timeSpec.endAt, remindAt: row.timeSpec.remindAt, itemKind: row.timeSpec.itemKind ?? null },
            sessions, createdIds, undoneAt: null,
          },
        };
        result = { state: 'accepted', undoUntil, replayed: false };
      }
    }

    if (transition) {
      writeDomainDiff(tx, uid, state, transition.state, transition.events, user, at);
      recordActivityEvents(tx, uid, stats, transition.events);
    }
    tx.set(recordPath(uid, id), next);
    tx.create<CommitmentActionReceipt>(receiptPath, {
      clientActionId: input.clientActionId, commitmentId: id, fingerprint,
      result: transition ? 'applied' : 'noop', createdAt: at,
      expiresAt: new Date(now.getTime() + COMMITMENT_ACTION_RECEIPT_TTL_MS),
    });
  });
  // A stale proposal found inside the transaction is answered with the fresh one.
  return result;
}

export async function acceptReschedule(uid: string, id: string, input: { proposalId: string; clientActionId: string; storage?: StorageAdapter; now?: Date }): Promise<DecisionResult> {
  try { return await decide(uid, id, 'accept', input); } catch (error) {
    if (error instanceof RescheduleStaleError && error.fresh === null) {
      const fresh = await computeOne(uid, id, input.storage ?? getStorage(), input.now ?? new Date());
      throw new RescheduleStaleError(fresh?.proposal ?? null);
    }
    throw error;
  }
}

export function dismissReschedule(uid: string, id: string, input: { clientActionId: string; storage?: StorageAdapter; now?: Date }): Promise<DecisionResult> {
  return decide(uid, id, 'dismiss', input);
}

export function undoReschedule(uid: string, id: string, input: { clientActionId: string; storage?: StorageAdapter; now?: Date }): Promise<DecisionResult> {
  return decide(uid, id, 'undo', input);
}

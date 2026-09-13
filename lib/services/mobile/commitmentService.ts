import type { Command, Commitment, DomainState, Priority, Reminder, TimeSpec } from '../../../src/domain/stateMachine';
import { rankForMobile, type RankedItem } from '../../priority/mobileRanking';
import { resolveModuleRuntime } from '../../../src/contracts/v1/runtimeControls';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import {
  applyParticipantCommand,
  getParticipantStateSnapshot,
} from './participantState';
import { localDayKey, normalizeTimezone, parseIsoInstant, resolvedCommitmentTime } from './time';

const HIDDEN_LIST_STATUSES = new Set<Commitment['status']>(['dropped', 'archived']);

export interface CommitmentQueryOptions {
  now?: Date;
  timezone?: string;
  participantId?: string;
}

export interface PatchCommitmentInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  dueDate?: unknown;
  reminderTime?: unknown;
}

/**
 * Who is acting, and what they believed they were acting on.
 *
 * `expectedUpdatedAt` is the `If-Match` validator (UC-1.4, #148). Absent, the
 * mutation is unconditional, which is what every client did before this and
 * still does for a first write.
 */
export interface CommitmentMutationOptions {
  participantId?: string;
  /** The `If-Match` validator the caller sent back, if any. */
  expectedValidator?: string;
}

function sortByResolvedTime(items: Commitment[]): Commitment[] {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(resolvedCommitmentTime(a) || a.updatedAt);
    const bTime = Date.parse(resolvedCommitmentTime(b) || b.updatedAt);
    return aTime - bTime;
  });
}

function isVisibleInLists(commitment: Commitment): boolean {
  return !HIDDEN_LIST_STATUSES.has(commitment.status);
}

/**
 * Ranked order, or the time order the lists have always used (UC-2.8, #169).
 *
 * The flag decides, per request, so turning ranking off is a config change and
 * not a deploy — and `MAYBESITTER_FEATURE_PRIORITY=false` gives byte-identical
 * output to the sort this function replaces, which a test asserts.
 */
function orderForLists(
  commitments: Commitment[],
  reminders: readonly Reminder[],
  now: Date,
): { items: Commitment[]; ranking: Map<string, RankedItem> } {
  if (resolveModuleRuntime('priority').mode !== 'enabled') {
    return { items: sortByResolvedTime(commitments), ranking: new Map() };
  }
  const ranked = rankForMobile(commitments, reminders, now.toISOString());
  const ranking = new Map(ranked.map((entry) => [entry.commitmentId, entry]));
  const byId = new Map(commitments.map((commitment) => [commitment.id, commitment]));
  return {
    items: ranked.map((entry) => byId.get(entry.commitmentId)!).filter(Boolean),
    ranking,
  };
}

/** Async since UC-1.0b (#141): a participant's state is a storage read. */
async function stateFor(options: { participantId?: string } = {}): Promise<DomainState> {
  if (options.participantId) return getParticipantStateSnapshot(options.participantId);
  configureCommandService({});
  return getCommandServiceState();
}

/** The commitments and their ranking, so a route can send both. */
export interface RankedCommitments {
  items: Commitment[];
  ranking: Map<string, RankedItem>;
}

export async function listTodayRanked(options: CommitmentQueryOptions = {}): Promise<RankedCommitments> {
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const today = localDayKey(now, timezone);
  const state = await stateFor(options);
  const items = Object.values(state.commitments).filter((commitment) => {
    if (!isVisibleInLists(commitment)) return false;
    const resolved = resolvedCommitmentTime(commitment);
    // An item with no time belongs to today: it is not scheduled for another
    // day, and hiding it meant "Buy milk" never reached a phone at all (#169).
    // Ranking puts it after the dated items it ties with, saying `no_deadline`.
    if (!resolved) return resolveModuleRuntime('priority').mode === 'enabled';
    return localDayKey(resolved, timezone) === today;
  });
  return orderForLists(items, Object.values(state.reminders), now);
}

export async function listToday(options: CommitmentQueryOptions = {}): Promise<Commitment[]> {
  return (await listTodayRanked(options)).items;
}

export async function listUpcomingRanked(options: CommitmentQueryOptions = {}): Promise<RankedCommitments> {
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const today = localDayKey(now, timezone);
  const state = await stateFor(options);
  const items = Object.values(state.commitments).filter((commitment) => {
    const resolved = resolvedCommitmentTime(commitment);
    // Upcoming is "a later day", so an undated item is never in it — it has no
    // later day to be on. It stays on Today.
    return Boolean(resolved) && isVisibleInLists(commitment) && localDayKey(resolved as string, timezone) > today;
  });
  return orderForLists(items, Object.values(state.reminders), now);
}

export async function listUpcoming(options: CommitmentQueryOptions = {}): Promise<Commitment[]> {
  return (await listUpcomingRanked(options)).items;
}

export async function getCommitment(id: string, options: { participantId?: string } = {}): Promise<Commitment | null> {
  return (await stateFor(options)).commitments[id] ?? null;
}

function priorityFromMobile(value: unknown): Partial<Priority> | undefined {
  if (value === undefined) return undefined;
  if (value !== 'low' && value !== 'normal' && value !== 'high') {
    throw new Error('priority must be low, normal, or high');
  }
  return {
    level: value,
    source: 'user_explicit',
    pressureAllowed: false,
    pressureLevel: 'none',
  };
}

function patchTimeSpec(current: TimeSpec, input: PatchCommitmentInput): Partial<TimeSpec> | undefined {
  const hasDueDate = input.dueDate !== undefined;
  const hasReminderTime = input.reminderTime !== undefined;
  if (!hasDueDate && !hasReminderTime) return undefined;

  const dueAt = hasDueDate ? parseIsoInstant(input.dueDate, 'dueDate').toISOString() : current.dueAt;
  let remindAt: string | null;
  if (hasReminderTime) {
    remindAt = parseIsoInstant(input.reminderTime, 'reminderTime').toISOString();
  } else if (hasDueDate && current.dueAt && current.remindAt && dueAt) {
    // Keep the gap the user chose rather than collapsing the reminder onto the
    // new due date or stranding it at the old one.
    const lead = Date.parse(current.dueAt) - Date.parse(current.remindAt);
    remindAt = new Date(Date.parse(dueAt) - lead).toISOString();
  } else if (hasDueDate && !current.remindAt) {
    remindAt = null;
  } else {
    remindAt = current.remindAt;
  }

  return {
    kind: dueAt || remindAt ? 'due_by' : 'unscheduled',
    dueAt,
    remindAt,
    timezone: current.timezone,
  } as Partial<TimeSpec>;
}

export const patchTimeSpecForTest = patchTimeSpec;

function stringField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

export async function patchCommitment(
  id: string,
  input: PatchCommitmentInput,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const current = await getCommitment(id, options);
  if (!current) throw new Error('Commitment not found');

  const updates: Extract<Command, { type: 'UpdateCommitment' }>['updates'] = {
    title: stringField(input.title, 'title'),
    description: stringField(input.description, 'description'),
    priority: priorityFromMobile(input.priority),
    timeSpec: patchTimeSpec(current.timeSpec, input),
  };

  const command: Command = {
    type: 'UpdateCommitment',
    commitmentId: id,
    now: now.toISOString(),
    updates,
  };
  await applyCommitmentCommand(id, command, options, 'Could not update commitment');
  return (await getCommitment(id, options)) ?? current;
}

/**
 * The state machine refused the move: completing a completed commitment,
 * postponing a dropped one. The route answers 409 rather than pretending it
 * worked (#148).
 */
export class InvalidTransitionError extends Error {
  constructor() {
    super('invalid_transition');
    this.name = 'InvalidTransitionError';
  }
}

/**
 * One command against one commitment, with the caller's `If-Match` expectation
 * carried into the same transaction that writes.
 */
async function applyCommitmentCommand(
  id: string,
  command: Command,
  options: CommitmentMutationOptions,
  rejection: string,
): Promise<void> {
  if (!options.participantId && options.expectedValidator !== undefined) {
    // The in-process path has no transaction to check inside, so honouring an
    // If-Match there would be a claim this cannot keep. Every authenticated
    // route supplies a participant; this only fires for a caller that does not.
    throw new Error('If-Match requires an authenticated participant');
  }
  const result = options.participantId
    ? await applyParticipantCommand(
        options.participantId,
        command,
        options.expectedValidator === undefined
          ? undefined
          : { commitmentId: id, validator: options.expectedValidator },
      )
    : applyCommand(command);
  if (result.result === 'rejected') throw new Error(rejection);
  if (result.result === 'invalid_transition') throw new InvalidTransitionError();
}

export async function completeCommitment(
  id: string,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const command: Command = { type: 'Complete', commitmentId: id, now: now.toISOString() };
  await applyCommitmentCommand(id, command, options, 'Could not complete commitment');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export async function postponeCommitment(
  id: string,
  postponedUntil: unknown,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const parsed = parseIsoInstant(postponedUntil, 'postponedUntil');
  if (parsed.getTime() <= now.getTime()) throw new Error('postponedUntil must be after now');
  const command: Command = {
    type: 'Postpone',
    commitmentId: id,
    postponedUntil: parsed.toISOString(),
    now: now.toISOString(),
  };
  await applyCommitmentCommand(id, command, options, 'Could not postpone commitment');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export async function dropCommitment(
  id: string,
  now: Date = new Date(),
  options: CommitmentMutationOptions = {},
): Promise<Commitment> {
  const command: Command = { type: 'Drop', commitmentId: id, now: now.toISOString() };
  await applyCommitmentCommand(id, command, options, 'Could not delete commitment');
  const commitment = await getCommitment(id, options);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

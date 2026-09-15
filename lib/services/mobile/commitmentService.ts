import type { Command, Commitment, DomainState, Priority, Reminder, TimeSpec } from '../../../src/domain/stateMachine';
import { rankForMobile, type RankedItem } from '../../priority/mobileRanking';
import { resolveModuleRuntime } from '../../../src/contracts/v1/runtimeControls';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import {
  applyParticipantCommand,
  getParticipantStateSnapshot,
} from './participantState';
import {
  isPastCommitmentTime,
  pastTimeMessage,
  reminderLeadNoLongerFitsMessage,
} from '../commitments/timeRules';
import { isDateOnly, localDayKey, normalizeTimezone, parseIsoInstant, resolvedCommitmentTime } from './time';

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

/**
 * One client-supplied time field: an instant, or `null` for "no time".
 *
 * `null` and absent are not the same answer. Absent means the edit did not
 * touch the time; `null` means the user removed it (UC-2.R3, #173), which is a
 * choice `applyEdits.ts` has always allowed on the capture path and which a
 * commitment that already exists had no way to express. `null` is not a time,
 * so the clock has nothing to say about it.
 *
 * A time that *is* supplied goes through the same past-time rule the capture
 * path enforces (#352). This used to take no clock at all, which is how the
 * boundary came to accept a `dueDate` the edit sheet and the capture path both
 * refused: a reminder behind the clock is one that will never fire.
 */
function optionalInstant(value: unknown, field: string, now: Date): string | null {
  if (value === null) return null;
  // A bare `YYYY-MM-DD` is refused for being a date, and not for whatever the
  // hour it would have been given turns out to mean (#352).
  //
  // `parseIsoInstant` resolves one to UTC midnight, so today's date arrived
  // here already behind the clock and was answered "must not be in the past" —
  // a true sentence about a fabricated instant, and a baffling one to read
  // about today. A *future* bare date was worse, because it was accepted: it
  // stored 00:00Z, which is 03:00 for this product's default Asia/Jerusalem
  // user, so a reminder fired at three in the morning on a day whose hour
  // nobody had chosen. Both halves are the same mistake — a value with no hour
  // being given one — and neither is a thing to guess at.
  //
  // This is a rule about the shape of a client field, so the shape test lives
  // in `time.ts` and the refusal here, rather than in `timeRules.ts` next to
  // the past-time rule. `validateEdit` asks the same question of a capture
  // edit's `resolvedTime` now (#375) and answers it in its own vocabulary; the
  // note that once stood here, saying the capture path could not reach a bare
  // date, was true of the app's own screens and not of its boundary.
  if (isDateOnly(value)) throw new Error(`${field} must name a time of day, not only a date`);
  const parsed = parseIsoInstant(value, field);
  if (isPastCommitmentTime(parsed, now)) throw new Error(pastTimeMessage(field));
  return parsed.toISOString();
}

/**
 * `now` is the request's clock, not this function's own.
 *
 * It judges only the fields the patch supplies. The commitment's existing time
 * is never re-judged: there is no "overdue" in this product, and an item whose
 * hour has gone must stay editable, or a typo in yesterday's title could never
 * be fixed.
 *
 * -- The derived reminder is judged too (#375) --------------------
 *
 * The `remindAt` derived below from a preserved lead is written by this patch,
 * at this clock, so it faces the same rule as one a client sends. Move a due
 * date to an hour from now on an item whose reminder ran two hours ahead of it
 * and the derived reminder is an hour behind the clock — exactly the
 * reminder-that-never-fires this function refuses when asked for it directly,
 * arriving through the other door.
 *
 * #375 chose refusal over the alternatives. Clamping the lead to `now` and
 * dropping the reminder are both silent rewrites of a time the user chose: the
 * edit sheet would go on showing a lead the server had quietly moved or
 * deleted, and they would find out when the reminder came at the wrong hour or
 * never came at all. A refusal costs one more tap and is the only outcome they
 * can act on, so it names what collided and what to do about it.
 *
 * It refuses the whole patch, not only the time. The due date in the same
 * request is fine on its own, but storing it alone would leave the commitment
 * moved with a reminder the user still believes tracks it — the silent
 * half-write this function exists to prevent.
 */
function patchTimeSpec(current: TimeSpec, input: PatchCommitmentInput, now: Date): Partial<TimeSpec> | undefined {
  const hasDueDate = input.dueDate !== undefined;
  const hasReminderTime = input.reminderTime !== undefined;
  if (!hasDueDate && !hasReminderTime) return undefined;

  const dueAt = hasDueDate ? optionalInstant(input.dueDate, 'dueDate', now) : current.dueAt;
  let remindAt: string | null;
  if (hasReminderTime) {
    remindAt = optionalInstant(input.reminderTime, 'reminderTime', now);
  } else if (hasDueDate && current.dueAt && current.remindAt && dueAt) {
    // Keep the gap the user chose rather than collapsing the reminder onto the
    // new due date or stranding it at the old one.
    const lead = Date.parse(current.dueAt) - Date.parse(current.remindAt);
    const derived = new Date(Date.parse(dueAt) - lead);
    // The one comparison, asked about a value this patch produced rather than
    // one it was handed. `isPastCommitmentTime` rather than a second `<` here,
    // so the derived reminder can never end up a millisecond stricter or looser
    // than a supplied one (#352, #375).
    if (isPastCommitmentTime(derived, now)) throw new Error(reminderLeadNoLongerFitsMessage('dueDate'));
    remindAt = derived.toISOString();
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
    timeSpec: patchTimeSpec(current.timeSpec, input, now),
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

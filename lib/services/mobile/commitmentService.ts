import type { Command, Commitment, Priority, TimeSpec } from '../../../src/domain/stateMachine';
import { applyCommand, configureCommandService, getCommandServiceState } from '../commandService';
import { localDayKey, normalizeTimezone, parseIsoDate, resolvedCommitmentTime } from './time';

const HIDDEN_LIST_STATUSES = new Set<Commitment['status']>(['dropped', 'archived']);

export interface CommitmentQueryOptions {
  now?: Date;
  timezone?: string;
}

export interface PatchCommitmentInput {
  title?: unknown;
  description?: unknown;
  priority?: unknown;
  dueDate?: unknown;
  reminderTime?: unknown;
}

function sortByResolvedTime(items: Commitment[]): Commitment[] {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(resolvedCommitmentTime(a) || a.updatedAt);
    const bTime = Date.parse(resolvedCommitmentTime(b) || b.updatedAt);
    return aTime - bTime;
  });
}

function isVisibleInLists(commitment: Commitment): boolean {
  return !HIDDEN_LIST_STATUSES.has(commitment.status) && Boolean(resolvedCommitmentTime(commitment));
}

export function listToday(options: CommitmentQueryOptions = {}): Commitment[] {
  configureCommandService({});
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const today = localDayKey(now, timezone);
  return sortByResolvedTime(
    Object.values(getCommandServiceState().commitments).filter((commitment) => {
      const resolved = resolvedCommitmentTime(commitment);
      return Boolean(resolved) && isVisibleInLists(commitment) && localDayKey(resolved as string, timezone) === today;
    })
  );
}

export function listUpcoming(options: CommitmentQueryOptions = {}): Commitment[] {
  configureCommandService({});
  const now = options.now ?? new Date();
  const timezone = normalizeTimezone(options.timezone);
  const today = localDayKey(now, timezone);
  return sortByResolvedTime(
    Object.values(getCommandServiceState().commitments).filter((commitment) => {
      const resolved = resolvedCommitmentTime(commitment);
      return Boolean(resolved) && isVisibleInLists(commitment) && localDayKey(resolved as string, timezone) > today;
    })
  );
}

export function getCommitment(id: string): Commitment | null {
  configureCommandService({});
  return getCommandServiceState().commitments[id] ?? null;
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

  const dueAt = hasDueDate ? parseIsoDate(input.dueDate, 'dueDate').toISOString() : current.dueAt;
  const remindAt = hasReminderTime
    ? parseIsoDate(input.reminderTime, 'reminderTime').toISOString()
    : hasDueDate
      ? dueAt
      : current.remindAt;

  return {
    kind: dueAt || remindAt ? 'due_by' : 'unscheduled',
    dueAt,
    remindAt,
    timezone: current.timezone,
  } as Partial<TimeSpec>;
}

function stringField(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

export function patchCommitment(id: string, input: PatchCommitmentInput, now: Date = new Date()): Commitment {
  configureCommandService({});
  const current = getCommitment(id);
  if (!current) throw new Error('Commitment not found');

  const updates: Extract<Command, { type: 'UpdateCommitment' }>['updates'] = {
    title: stringField(input.title, 'title'),
    description: stringField(input.description, 'description'),
    priority: priorityFromMobile(input.priority),
    timeSpec: patchTimeSpec(current.timeSpec, input),
  };

  const result = applyCommand({
    type: 'UpdateCommitment',
    commitmentId: id,
    now: now.toISOString(),
    updates,
  });
  if (result.result === 'rejected') throw new Error('Could not update commitment');
  return getCommitment(id) ?? current;
}

export function completeCommitment(id: string, now: Date = new Date()): Commitment {
  configureCommandService({});
  const result = applyCommand({ type: 'Complete', commitmentId: id, now: now.toISOString() });
  if (result.result === 'rejected') throw new Error('Could not complete commitment');
  const commitment = getCommitment(id);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export function postponeCommitment(id: string, postponedUntil: unknown, now: Date = new Date()): Commitment {
  configureCommandService({});
  const parsed = parseIsoDate(postponedUntil, 'postponedUntil');
  if (parsed.getTime() <= now.getTime()) throw new Error('postponedUntil must be after now');
  const result = applyCommand({
    type: 'Postpone',
    commitmentId: id,
    postponedUntil: parsed.toISOString(),
    now: now.toISOString(),
  });
  if (result.result === 'rejected') throw new Error('Could not postpone commitment');
  const commitment = getCommitment(id);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

export function dropCommitment(id: string, now: Date = new Date()): Commitment {
  configureCommandService({});
  const result = applyCommand({ type: 'Drop', commitmentId: id, now: now.toISOString() });
  if (result.result === 'rejected') throw new Error('Could not delete commitment');
  const commitment = getCommitment(id);
  if (!commitment) throw new Error('Commitment not found');
  return commitment;
}

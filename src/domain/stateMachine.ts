import { randomUUID } from 'crypto';

export type CommitmentKind = 'task' | 'follow_up';
export type CommitmentStatus =
  | 'draft'
  | 'needs_clarification'
  | 'pending_confirmation'
  | 'active'
  | 'deferred'
  | 'completed'
  | 'dropped'
  | 'missed'
  | 'archived';

export type AckState = 'not_seen' | 'seen' | 'aware' | 'postponed' | 'completed' | 'ignored';
export type ReminderStatus =
  | 'scheduled'
  | 'delivered'
  | 'acknowledged'
  | 'snoozed'
  | 'completed_from_prompt'
  | 'ignored'
  | 'cancelled'
  | 'expired';

export type EscalationStatus = 'none' | 'eligible' | 'active' | 'capped' | 'stopped';
export type ReminderType = 'check_in' | 'due_soon' | 'due_now' | 'escalation' | 'clarification';

export interface Priority {
  level: 'low' | 'normal' | 'high';
  source: 'default' | 'inferred' | 'user_explicit';
  pressureAllowed: boolean;
  pressureLevel: 'none' | 'gentle' | 'firm';
}

/**
 * When a commitment happens, in four answers rather than one (#185).
 *
 * `dueAt` alone says a commitment names an instant and nothing about how long
 * it lasts or whether the hour was ever chosen. That was enough while the only
 * consumer was a reminder, which is a point in time by construction. It is not
 * enough for a calendar: an event has a start *and* an end, and "Thursday" is
 * not the same claim as "Thursday at 00:00".
 *
 * ── `endAt` ──────────────────────────────────────────────────────
 *
 * The instant the commitment stops, or `null` when it names no end. `null` is
 * not "zero minutes" and it is not "thirty minutes": it is the absence of an
 * answer, and every consumer decides what to draw for it in its own vocabulary
 * — `eventDraft.ts` in the app gives an ended-less commitment a default block
 * because a calendar cannot render a point, and that is a fact about calendars
 * rather than about this commitment.
 *
 * ── `allDay` ─────────────────────────────────────────────────────
 *
 * True when the commitment names a *day* and not a time of day. `dueAt` still
 * carries an instant — local midnight of that day in `timezone` — because one
 * representation is what keeps this type readable, and because a bare
 * `YYYY-MM-DD` is exactly the value `optionalInstant` refuses for being a date
 * that would have to be given a fabricated hour. The flag is what says the hour
 * in there was never chosen by anybody, so nothing may present it as one.
 *
 * ── Why both are required rather than optional ───────────────────
 *
 * An optional field is a field a producer can forget, and the failure is
 * silent: the commitment reads as a point in time, the calendar writes a
 * thirty-minute block over somebody's day off, and no test can tell that from a
 * commitment that genuinely is a point. Required means `defaultTimeSpec` fills
 * them, one function decides the defaults, and `timeSpecSchema` in the app can
 * *require* them on the wire — so a backend that stops sending one fails the
 * mobile suite instead of a user's calendar.
 */
export interface TimeSpec {
  kind: 'unscheduled' | 'due_by' | 'scheduled_event';
  dueAt: string | null;
  /** When it ends. `null` means the commitment names no end, not a zero-length one. */
  endAt: string | null;
  remindAt: string | null;
  /** The commitment names a day. `dueAt` is that day's local midnight, and nobody chose the hour. */
  allDay: boolean;
  timezone: string;
}

export interface Commitment {
  id: string;
  kind: CommitmentKind;
  title: string;
  description: string | null;
  person: string | null;
  status: CommitmentStatus;
  priority: Priority;
  timeSpec: TimeSpec;
  currentAckState: AckState;
  postponedUntil: string | null;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  completedAt: string | null;
  droppedAt: string | null;
}

export interface Reminder {
  id: string;
  commitmentId: string;
  reminderType: ReminderType;
  scheduledFor: string;
  status: ReminderStatus;
  requiresAction: boolean;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  snoozedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EscalationState {
  commitmentId: string;
  status: EscalationStatus;
  level: number;
  perCycleCount: number;
  lastEscalatedAt: string | null;
}

export interface DomainState {
  commitments: Record<string, Commitment>;
  reminders: Record<string, Reminder>;
  escalationStates: Record<string, EscalationState>;
}

export interface DomainEvent {
  id: string;
  type: string;
  at: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export type SideEffect =
  | { type: 'schedule_reminder'; reminderId: string; runAt: string }
  | { type: 'cancel_reminders'; commitmentId: string }
  | { type: 'schedule_ignored_check'; reminderId: string; runAt: string }
  | { type: 'send_reminder'; reminderId: string }
  | { type: 'trigger_escalation'; commitmentId: string }
  | { type: 'send_escalation'; commitmentId: string; level: number }
  | { type: 'cancel_escalation'; commitmentId: string };

export interface StateTransitionResult {
  newState: DomainState;
  events: DomainEvent[];
  sideEffects: SideEffect[];
  didChange: boolean;
}

export type CreateDraft = {
  type: 'CreateDraft';
  now: string;
  commitment: {
    id: string;
    kind: CommitmentKind;
    title: string;
    description?: string | null;
    person?: string | null;
    priority?: Partial<Priority>;
    timeSpec?: Partial<TimeSpec>;
  };
  draftStatus?: Extract<CommitmentStatus, 'draft' | 'needs_clarification' | 'pending_confirmation'>;
};

export type ConfirmCommitment = {
  type: 'ConfirmCommitment';
  commitmentId: string;
  now: string;
  reminders?: ReminderInput[];
};

export interface ReminderInput {
  id: string;
  reminderType?: ReminderType;
  scheduledFor: string;
  requiresAction?: boolean;
}

export type MarkAware = {
  type: 'MarkAware';
  commitmentId: string;
  now: string;
  reminderId?: string;
};

export type Complete = {
  type: 'Complete';
  commitmentId: string;
  now: string;
};

export type Postpone = {
  type: 'Postpone';
  commitmentId: string;
  postponedUntil: string;
  now: string;
  reminderId?: string;
};

export type Drop = {
  type: 'Drop';
  commitmentId: string;
  now: string;
};

export type Deprioritize = {
  type: 'Deprioritize';
  commitmentId: string;
  now: string;
};

export type UpdateCommitment = {
  type: 'UpdateCommitment';
  commitmentId: string;
  now: string;
  updates: {
    title?: string;
    description?: string | null;
    person?: string | null;
    priority?: Partial<Priority>;
    timeSpec?: Partial<TimeSpec>;
  };
};

export type ReminderTriggered = {
  type: 'ReminderTriggered';
  reminderId: string;
  now: string;
};

export type ReminderIgnored = {
  type: 'ReminderIgnored';
  reminderId: string;
  now: string;
};

export type EscalationTriggered = {
  type: 'EscalationTriggered';
  commitmentId: string;
  now: string;
};

export type Command =
  | CreateDraft
  | ConfirmCommitment
  | MarkAware
  | Complete
  | Postpone
  | Drop
  | Deprioritize
  | UpdateCommitment
  | ReminderTriggered
  | ReminderIgnored
  | EscalationTriggered;

export class InvalidStateTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidStateTransitionError';
  }
}

export class MissingEntityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissingEntityError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const OPEN_REMINDER_STATUSES: ReminderStatus[] = ['scheduled', 'delivered', 'snoozed'];
const ESCALATION_COOLDOWN_MS = 2 * 60 * 1000;

export function createEmptyDomainState(): DomainState {
  return {
    commitments: {},
    reminders: {},
    escalationStates: {},
  };
}

function cloneState(state: DomainState): DomainState {
  return JSON.parse(JSON.stringify(state)) as DomainState;
}

function makeEvent(type: string, at: string, aggregateId: string, payload: Record<string, unknown> = {}): DomainEvent {
  return { id: randomUUID(), type, at, aggregateId, payload };
}

function defaultPriority(priority?: Partial<Priority>): Priority {
  return {
    level: priority?.level || 'normal',
    source: priority?.source || 'default',
    pressureAllowed: priority?.pressureAllowed || false,
    pressureLevel: priority?.pressureLevel || 'none',
  };
}

/**
 * The complete time spec, and the three things it refuses to store (#185).
 *
 * The defaults are the shape every commitment had before `endAt` and `allDay`
 * existed: no end, not all-day. So a producer that has nothing to say about
 * either keeps producing exactly what it produced, and the new fields mean
 * "nobody said" rather than "somebody said no".
 *
 * The refusals are here rather than at a boundary because they are properties
 * of the value, not of one caller's request. A range that ends before it starts
 * and a day-long commitment on no day are not states a screen should have to
 * render, and letting them through would mean every reader of a `TimeSpec`
 * carries the check instead.
 */
/**
 * The stored shape, completed — and the only place the defaults are written.
 *
 * Separate from `defaultTimeSpec` because it has a second caller with a
 * different need. `defaultTimeSpec` is the *write* path: it refuses what must
 * never be stored. This is the *read* path, and it is total — it fills the
 * fields a document written by an older version of this file does not have,
 * and it judges nothing.
 *
 * ── Why the read path fills anything at all ──────────────────────
 *
 * `endAt` and `allDay` were added to a store that already had commitments in
 * it (#185) — the first time this repository has widened a type over live data.
 * `loadDomainState` hands a raw storage document straight into the state and
 * `commitmentToMobileDto` copies `timeSpec` through verbatim, so without this a
 * commitment written last month reaches the phone missing two keys its schema
 * requires, and because a list is parsed as one value, one such row blanks the
 * whole screen rather than its own card.
 *
 * Filling on read rather than migrating is deliberate. A document is repaired
 * at the moment it is read, which is the only moment it matters, so one nobody
 * opens for six months is correct on the day they finally do — and one written
 * by an older instance during a rolling deploy is correct too, which no
 * backfill run beforehand could promise. It is idempotent, so the repair costs
 * a complete record nothing.
 *
 * It refuses nothing on purpose. A read that threw would turn one bad document
 * into a 500 for every list that contains it, which is the same failure this
 * exists to prevent wearing a different uniform. The invariants still hold
 * where they can be enforced — on the way in.
 */
export function normalizeStoredTimeSpec(timeSpec?: Partial<TimeSpec>): TimeSpec {
  return {
    kind: timeSpec?.kind || 'unscheduled',
    dueAt: timeSpec?.dueAt || null,
    endAt: timeSpec?.endAt || null,
    remindAt: timeSpec?.remindAt || null,
    // `=== true` and not `!!`: a stored value that is a string, a number or
    // anything else a hand-edited document might hold must read as "nobody
    // said", never as an all-day entry written across somebody's calendar.
    allDay: timeSpec?.allDay === true,
    timezone: timeSpec?.timezone || 'UTC',
  };
}

/**
 * One commitment as it was stored, completed for the fields since added (#185).
 *
 * Applied by `loadDomainState` to every document it reads, which is the single
 * place a stored commitment becomes a domain one. Only `timeSpec` is completed:
 * it is the only object on `Commitment` this product has ever widened after
 * data existed. `priority`'s required fields date from the initial commit, so
 * no stored document has ever been without them — when that stops being true,
 * this is where the next one goes.
 */
export function normalizeStoredCommitment(commitment: Commitment): Commitment {
  return { ...commitment, timeSpec: normalizeStoredTimeSpec(commitment.timeSpec) };
}

function defaultTimeSpec(timeSpec?: Partial<TimeSpec>): TimeSpec {
  if (timeSpec?.dueAt) ensureValidDate(timeSpec.dueAt, 'timeSpec.dueAt');
  if (timeSpec?.endAt) ensureValidDate(timeSpec.endAt, 'timeSpec.endAt');
  if (timeSpec?.remindAt) ensureValidDate(timeSpec.remindAt, 'timeSpec.remindAt');

  const normalized = normalizeStoredTimeSpec(timeSpec);
  const { dueAt, endAt, allDay } = normalized;

  // An end with no start is not a range, it is half of one. Storing it would
  // leave every consumer to guess what the other half was.
  if (endAt && !dueAt) throw new ValidationError('timeSpec.endAt requires timeSpec.dueAt');
  // Strictly after, matching the half-open `[start, end)` convention
  // `lib/planning/shared/time.ts` fixed for the whole product: a zero-length
  // range is the empty set, and a calendar draws it as nothing at all.
  if (endAt && dueAt && Date.parse(endAt) <= Date.parse(dueAt)) {
    throw new ValidationError('timeSpec.endAt must be after timeSpec.dueAt');
  }
  // "All day" is a claim about *which* day. With no day it says nothing, and a
  // consumer reading the flag alone would write an event onto the epoch.
  if (allDay && !dueAt) throw new ValidationError('timeSpec.allDay requires timeSpec.dueAt');
  // And a claim about a *whole* day. `allDay` says the hour in `dueAt` was
  // never chosen by anybody, which is only true if it is the hour a day begins
  // at — so an all-day commitment at 15:00 is not a commitment with a stray
  // hour, it is two statements that contradict each other, and every consumer
  // downstream has to pick one. `eventDraft.ts` picks the day and the hour
  // disappears; an end half an hour later disappears the same way, and out of
  // the content hash with it, so the stored fact and the written event can
  // differ with nothing able to notice. Refused here rather than silently
  // rounded, because rounding is how the 15:00 got lost in the first place.
  if (allDay && dueAt && !isLocalMidnight(dueAt, normalized.timezone)) {
    throw new ValidationError('timeSpec.allDay requires timeSpec.dueAt at local midnight in timeSpec.timezone');
  }
  if (allDay && endAt && !isLocalMidnight(endAt, normalized.timezone)) {
    throw new ValidationError('timeSpec.allDay requires timeSpec.endAt at local midnight in timeSpec.timezone');
  }

  return normalized;
}

/**
 * Whether `iso` falls exactly at the start of a day in `timeZone` (#185).
 *
 * A formatting question, not an offset one: "what time is it there" rather than
 * "how far from UTC is there", so it needs no zone arithmetic and cannot be a
 * quarter-hour or a half-hour out in the zones that are. Milliseconds are the
 * one field `Intl` will not format, so they are read off the instant itself.
 *
 * An unusable zone answers `true`. The commitment carries its own `timezone`
 * and nothing validates it, and refusing an all-day commitment because the zone
 * string is unrecognised would be answering a question nobody asked with a
 * refusal nobody can act on.
 */
export function isLocalMidnight(iso: string, timeZone: string): boolean {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime()) || instant.getUTCMilliseconds() !== 0) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
  } catch {
    return true;
  }
  const at = (type: string) => parts.find((part) => part.type === type)?.value;
  return at('hour') === '00' && at('minute') === '00' && at('second') === '00';
}

function ensureValidDate(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be a valid ISO date`);
  }
}

function requireCommitment(state: DomainState, commitmentId: string): Commitment {
  const commitment = state.commitments[commitmentId];
  if (!commitment) throw new MissingEntityError(`Commitment not found: ${commitmentId}`);
  return commitment;
}

function requireReminder(state: DomainState, reminderId: string): Reminder {
  const reminder = state.reminders[reminderId];
  if (!reminder) throw new MissingEntityError(`Reminder not found: ${reminderId}`);
  return reminder;
}

function ensureCommitmentStatus(commitment: Commitment, allowed: CommitmentStatus[], command: string): void {
  if (!allowed.includes(commitment.status)) {
    throw new InvalidStateTransitionError(
      `${command} is not allowed for commitment ${commitment.id} in state ${commitment.status}`
    );
  }
}

function remindersForCommitment(state: DomainState, commitmentId: string): Reminder[] {
  return Object.values(state.reminders).filter((reminder) => reminder.commitmentId === commitmentId);
}

function cancelOpenReminders(state: DomainState, commitmentId: string, now: string): void {
  for (const reminder of remindersForCommitment(state, commitmentId)) {
    if (OPEN_REMINDER_STATUSES.includes(reminder.status)) {
      state.reminders[reminder.id] = { ...reminder, status: 'cancelled', updatedAt: now };
    }
  }
}

function addReminder(state: DomainState, commitmentId: string, reminderInput: ReminderInput, now: string): void {
  ensureValidDate(reminderInput.scheduledFor, 'reminder.scheduledFor');
  if (state.reminders[reminderInput.id]) {
    throw new InvalidStateTransitionError(`Reminder already exists: ${reminderInput.id}`);
  }
  state.reminders[reminderInput.id] = {
    id: reminderInput.id,
    commitmentId,
    reminderType: reminderInput.reminderType || 'check_in',
    scheduledFor: reminderInput.scheduledFor,
    status: 'scheduled',
    requiresAction: reminderInput.requiresAction !== false,
    deliveredAt: null,
    acknowledgedAt: null,
    snoozedUntil: null,
    createdAt: now,
    updatedAt: now,
  };
}

function ensureEscalationState(state: DomainState, commitmentId: string): EscalationState {
  if (!state.escalationStates[commitmentId]) {
    state.escalationStates[commitmentId] = {
      commitmentId,
      status: 'none',
      level: 0,
      perCycleCount: 0,
      lastEscalatedAt: null,
    };
  }
  return state.escalationStates[commitmentId];
}

function assertInvariants(state: DomainState): void {
  for (const commitment of Object.values(state.commitments)) {
    if (!commitment.title.trim()) throw new ValidationError(`Commitment ${commitment.id} has an empty title`);

    if (['completed', 'dropped', 'archived'].includes(commitment.status)) {
      for (const reminder of remindersForCommitment(state, commitment.id)) {
        if (OPEN_REMINDER_STATUSES.includes(reminder.status)) {
          throw new ValidationError(`Closed commitment ${commitment.id} has open reminder ${reminder.id}`);
        }
      }
    }

    if (commitment.currentAckState === 'postponed' && commitment.postponedUntil) {
      const postponedUntil = Date.parse(commitment.postponedUntil);
      for (const reminder of remindersForCommitment(state, commitment.id)) {
        if (reminder.status === 'scheduled' && Date.parse(reminder.scheduledFor) < postponedUntil) {
          throw new ValidationError(`Postponed commitment ${commitment.id} has reminder before postponedUntil`);
        }
      }
    }

    const escalation = state.escalationStates[commitment.id];
    if (escalation?.status === 'active' && !commitment.priority.pressureAllowed) {
      throw new ValidationError(`Commitment ${commitment.id} has active escalation without pressure`);
    }
  }
}

function ignoredCheckAt(deliveredAt: string): string {
  return new Date(Date.parse(deliveredAt) + 10 * 60 * 1000).toISOString();
}

function canEscalate(commitment: Commitment, escalation: EscalationState): boolean {
  return (
    ['active', 'deferred', 'missed'].includes(commitment.status) &&
    commitment.currentAckState === 'ignored' &&
    commitment.priority.level === 'high' &&
    commitment.priority.pressureAllowed &&
    ['eligible', 'active'].includes(escalation.status) &&
    escalation.perCycleCount < 3
  );
}

function isInsideEscalationCooldown(escalation: EscalationState, now: string): boolean {
  return Boolean(
    escalation.lastEscalatedAt &&
    Date.parse(now) - Date.parse(escalation.lastEscalatedAt) < ESCALATION_COOLDOWN_MS
  );
}

export function applyCommand(state: DomainState, command: Command): StateTransitionResult {
  ensureValidDate(command.now, 'command.now');
  const newState = cloneState(state);
  const events: DomainEvent[] = [];
  const sideEffects: SideEffect[] = [];
  let didChange = false;

  switch (command.type) {
    case 'CreateDraft': {
      if (newState.commitments[command.commitment.id]) {
        throw new InvalidStateTransitionError(`Commitment already exists: ${command.commitment.id}`);
      }
      const status = command.draftStatus || 'draft';
      if (!['draft', 'needs_clarification', 'pending_confirmation'].includes(status)) {
        throw new InvalidStateTransitionError(`Invalid draft status: ${status}`);
      }
      const commitment: Commitment = {
        id: command.commitment.id,
        kind: command.commitment.kind,
        title: command.commitment.title.trim(),
        description: command.commitment.description || null,
        person: command.commitment.person || null,
        status,
        priority: defaultPriority(command.commitment.priority),
        timeSpec: defaultTimeSpec(command.commitment.timeSpec),
        currentAckState: 'not_seen',
        postponedUntil: null,
        createdAt: command.now,
        updatedAt: command.now,
        confirmedAt: null,
        completedAt: null,
        droppedAt: null,
      };
      newState.commitments[commitment.id] = commitment;
      ensureEscalationState(newState, commitment.id);
      events.push(makeEvent('draft_created', command.now, commitment.id, { status }));
      didChange = true;
      break;
    }

    case 'ConfirmCommitment': {
      const commitment = requireCommitment(newState, command.commitmentId);
      if (commitment.status === 'active') {
        break;
      }
      ensureCommitmentStatus(commitment, ['draft', 'needs_clarification', 'pending_confirmation'], command.type);
      commitment.status = 'active';
      commitment.currentAckState = 'not_seen';
      commitment.confirmedAt = command.now;
      commitment.updatedAt = command.now;

      const reminders = command.reminders || (commitment.timeSpec.remindAt
        ? [{ id: `rem_${commitment.id}_initial`, reminderType: 'check_in' as ReminderType, scheduledFor: commitment.timeSpec.remindAt, requiresAction: true }]
        : []);
      for (const reminderInput of reminders) {
        addReminder(newState, commitment.id, reminderInput, command.now);
        sideEffects.push({ type: 'schedule_reminder', reminderId: reminderInput.id, runAt: reminderInput.scheduledFor });
      }
      events.push(makeEvent('commitment_activated', command.now, commitment.id));
      didChange = true;
      break;
    }

    case 'MarkAware': {
      const commitment = requireCommitment(newState, command.commitmentId);
      if (commitment.status === 'completed' || commitment.status === 'dropped' || commitment.status === 'archived') {
        break;
      }
      ensureCommitmentStatus(commitment, ['active', 'deferred', 'missed'], command.type);
      commitment.currentAckState = 'aware';
      commitment.updatedAt = command.now;
      commitment.postponedUntil = null;

      const reminders = command.reminderId
        ? [requireReminder(newState, command.reminderId)]
        : remindersForCommitment(newState, commitment.id).filter((reminder) => reminder.status === 'delivered');
      for (const reminder of reminders) {
        if (reminder.commitmentId !== commitment.id) {
          throw new InvalidStateTransitionError(`Reminder ${reminder.id} does not belong to ${commitment.id}`);
        }
        if (OPEN_REMINDER_STATUSES.includes(reminder.status)) {
          newState.reminders[reminder.id] = { ...reminder, status: 'acknowledged', acknowledgedAt: command.now, updatedAt: command.now };
        }
      }

      const escalation = ensureEscalationState(newState, commitment.id);
      if (escalation.status === 'active' || escalation.status === 'eligible') escalation.status = 'none';
      sideEffects.push({ type: 'cancel_escalation', commitmentId: commitment.id });
      events.push(makeEvent('commitment_aware', command.now, commitment.id));
      didChange = true;
      break;
    }

    case 'Complete': {
      const commitment = requireCommitment(newState, command.commitmentId);
      if (commitment.status === 'completed') {
        break;
      }
      ensureCommitmentStatus(commitment, ['active', 'deferred', 'missed'], command.type);
      commitment.status = 'completed';
      commitment.currentAckState = 'completed';
      commitment.completedAt = command.now;
      commitment.updatedAt = command.now;
      commitment.postponedUntil = null;
      cancelOpenReminders(newState, commitment.id, command.now);
      ensureEscalationState(newState, commitment.id).status = 'stopped';
      sideEffects.push({ type: 'cancel_reminders', commitmentId: commitment.id });
      sideEffects.push({ type: 'cancel_escalation', commitmentId: commitment.id });
      events.push(makeEvent('commitment_completed', command.now, commitment.id));
      didChange = true;
      break;
    }

    case 'Postpone': {
      const commitment = requireCommitment(newState, command.commitmentId);
      ensureCommitmentStatus(commitment, ['active', 'deferred', 'missed'], command.type);
      ensureValidDate(command.now, 'command.now');
      ensureValidDate(command.postponedUntil, 'postponedUntil');
      if (Date.parse(command.postponedUntil) <= Date.parse(command.now)) {
        throw new InvalidStateTransitionError('postponedUntil must be after now');
      }
      const reminderId = command.reminderId || `rem_${commitment.id}_postponed_${Date.parse(command.postponedUntil)}`;
      const existingReminder = newState.reminders[reminderId];
      if (
        commitment.currentAckState === 'postponed' &&
        commitment.postponedUntil === command.postponedUntil &&
        existingReminder?.commitmentId === commitment.id &&
        existingReminder.status === 'scheduled'
      ) {
        break;
      }
      commitment.currentAckState = 'postponed';
      commitment.postponedUntil = command.postponedUntil;
      commitment.updatedAt = command.now;
      cancelOpenReminders(newState, commitment.id, command.now);

      addReminder(newState, commitment.id, { id: reminderId, reminderType: 'check_in', scheduledFor: command.postponedUntil, requiresAction: true }, command.now);
      const escalation = ensureEscalationState(newState, commitment.id);
      if (escalation.status === 'active' || escalation.status === 'eligible') escalation.status = 'none';
      sideEffects.push({ type: 'schedule_reminder', reminderId, runAt: command.postponedUntil });
      sideEffects.push({ type: 'cancel_escalation', commitmentId: commitment.id });
      events.push(makeEvent('commitment_postponed', command.now, commitment.id, { postponedUntil: command.postponedUntil }));
      didChange = true;
      break;
    }

    case 'Drop': {
      const commitment = requireCommitment(newState, command.commitmentId);
      if (commitment.status === 'dropped') {
        break;
      }
      ensureCommitmentStatus(commitment, ['draft', 'needs_clarification', 'pending_confirmation', 'active', 'deferred', 'missed', 'completed'], command.type);
      commitment.status = 'dropped';
      commitment.currentAckState = 'completed';
      commitment.droppedAt = command.now;
      commitment.updatedAt = command.now;
      commitment.postponedUntil = null;
      cancelOpenReminders(newState, commitment.id, command.now);
      ensureEscalationState(newState, commitment.id).status = 'stopped';
      sideEffects.push({ type: 'cancel_reminders', commitmentId: commitment.id });
      sideEffects.push({ type: 'cancel_escalation', commitmentId: commitment.id });
      events.push(makeEvent('commitment_dropped', command.now, commitment.id));
      didChange = true;
      break;
    }

    case 'Deprioritize': {
      const commitment = requireCommitment(newState, command.commitmentId);
      if (commitment.status === 'completed' || commitment.status === 'dropped' || commitment.status === 'archived') {
        break;
      }
      ensureCommitmentStatus(commitment, ['draft', 'needs_clarification', 'pending_confirmation', 'active', 'deferred', 'missed'], command.type);
      if (
        commitment.priority.level === 'low' &&
        commitment.priority.source === 'user_explicit' &&
        !commitment.priority.pressureAllowed &&
        commitment.priority.pressureLevel === 'none'
      ) {
        break;
      }
      commitment.priority = {
        ...commitment.priority,
        level: 'low',
        source: 'user_explicit',
        pressureAllowed: false,
        pressureLevel: 'none',
      };
      commitment.updatedAt = command.now;
      events.push(makeEvent('commitment_deprioritized', command.now, commitment.id));
      didChange = true;
      break;
    }

    case 'UpdateCommitment': {
      const commitment = requireCommitment(newState, command.commitmentId);
      ensureCommitmentStatus(commitment, ['draft', 'needs_clarification', 'pending_confirmation', 'active', 'deferred', 'missed'], command.type);

      const nextTitle = command.updates.title === undefined ? commitment.title : command.updates.title.trim();
      if (!nextTitle) throw new ValidationError(`Commitment ${commitment.id} has an empty title`);

      const nextDescription = command.updates.description === undefined
        ? commitment.description
        : command.updates.description || null;
      const nextPerson = command.updates.person === undefined
        ? commitment.person
        : command.updates.person || null;
      const nextPriority = command.updates.priority
        ? { ...commitment.priority, ...command.updates.priority }
        : commitment.priority;
      const nextTimeSpec = command.updates.timeSpec
        ? defaultTimeSpec({ ...commitment.timeSpec, ...command.updates.timeSpec })
        : commitment.timeSpec;
      const timeSpecChanged = JSON.stringify(commitment.timeSpec) !== JSON.stringify(nextTimeSpec);

      if (
        commitment.title === nextTitle &&
        commitment.description === nextDescription &&
        commitment.person === nextPerson &&
        JSON.stringify(commitment.priority) === JSON.stringify(nextPriority) &&
        !timeSpecChanged
      ) {
        break;
      }

      commitment.title = nextTitle;
      commitment.description = nextDescription;
      commitment.person = nextPerson;
      commitment.priority = nextPriority;
      commitment.timeSpec = nextTimeSpec;
      commitment.updatedAt = command.now;
      if (timeSpecChanged) {
        cancelOpenReminders(newState, commitment.id, command.now);
        sideEffects.push({ type: 'cancel_reminders', commitmentId: commitment.id });
        if (nextTimeSpec.remindAt) {
          const reminderId = `rem_${commitment.id}_updated_${Date.parse(nextTimeSpec.remindAt)}_${Date.parse(command.now)}`;
          addReminder(newState, commitment.id, { id: reminderId, scheduledFor: nextTimeSpec.remindAt, requiresAction: true }, command.now);
          sideEffects.push({ type: 'schedule_reminder', reminderId, runAt: nextTimeSpec.remindAt });
        }
      }
      events.push(makeEvent('commitment_updated', command.now, commitment.id));
      didChange = true;
      break;
    }

    case 'ReminderTriggered': {
      const reminder = requireReminder(newState, command.reminderId);
      if (reminder.status === 'delivered' || reminder.status === 'acknowledged' || reminder.status === 'ignored' || reminder.status === 'cancelled' || reminder.status === 'completed_from_prompt' || reminder.status === 'expired') {
        break;
      }
      if (reminder.status !== 'scheduled') {
        throw new InvalidStateTransitionError(`ReminderTriggered is not allowed for reminder ${reminder.id} in state ${reminder.status}`);
      }
      const commitment = requireCommitment(newState, reminder.commitmentId);
      ensureCommitmentStatus(commitment, ['active', 'deferred', 'missed'], command.type);
      if (commitment.currentAckState === 'postponed' && commitment.postponedUntil && Date.parse(command.now) < Date.parse(commitment.postponedUntil)) {
        throw new InvalidStateTransitionError(`Reminder ${reminder.id} is suppressed until ${commitment.postponedUntil}`);
      }
      reminder.status = 'delivered';
      reminder.deliveredAt = command.now;
      reminder.updatedAt = command.now;
      if (commitment.currentAckState === 'not_seen') commitment.currentAckState = 'seen';
      commitment.updatedAt = command.now;
      sideEffects.push({ type: 'send_reminder', reminderId: reminder.id });
      if (reminder.requiresAction) sideEffects.push({ type: 'schedule_ignored_check', reminderId: reminder.id, runAt: ignoredCheckAt(command.now) });
      events.push(makeEvent('reminder_delivered', command.now, reminder.id, { commitmentId: commitment.id }));
      didChange = true;
      break;
    }

    case 'ReminderIgnored': {
      const reminder = requireReminder(newState, command.reminderId);
      if (reminder.status === 'ignored' || reminder.status === 'acknowledged' || reminder.status === 'cancelled' || reminder.status === 'completed_from_prompt' || reminder.status === 'expired' || reminder.status === 'snoozed' || reminder.status === 'scheduled') {
        break;
      }
      if (reminder.status !== 'delivered') {
        throw new InvalidStateTransitionError(`ReminderIgnored is not allowed for reminder ${reminder.id} in state ${reminder.status}`);
      }
      if (!reminder.requiresAction) throw new InvalidStateTransitionError(`Reminder ${reminder.id} does not require action`);
      if (!reminder.deliveredAt || Date.parse(command.now) < Date.parse(reminder.deliveredAt) + 10 * 60 * 1000) {
        throw new InvalidStateTransitionError(`Reminder ${reminder.id} cannot be ignored before 10 minutes after delivery`);
      }
      const commitment = requireCommitment(newState, reminder.commitmentId);
      ensureCommitmentStatus(commitment, ['active', 'deferred', 'missed'], command.type);
      if (!['seen', 'ignored'].includes(commitment.currentAckState)) {
        throw new InvalidStateTransitionError(`Reminder ${reminder.id} cannot be ignored because ack state is ${commitment.currentAckState}`);
      }
      reminder.status = 'ignored';
      reminder.updatedAt = command.now;
      commitment.currentAckState = 'ignored';
      commitment.updatedAt = command.now;
      const escalation = ensureEscalationState(newState, commitment.id);
      if (commitment.priority.level === 'high' && commitment.priority.pressureAllowed && escalation.perCycleCount < 3) {
        escalation.status = 'eligible';
        sideEffects.push({ type: 'trigger_escalation', commitmentId: commitment.id });
      }
      events.push(makeEvent('reminder_ignored', command.now, reminder.id, { commitmentId: commitment.id }));
      didChange = true;
      break;
    }

    case 'EscalationTriggered': {
      const commitment = requireCommitment(newState, command.commitmentId);
      const escalation = ensureEscalationState(newState, commitment.id);
      if (escalation.status === 'capped' || escalation.status === 'stopped' || isInsideEscalationCooldown(escalation, command.now)) {
        break;
      }
      if (!canEscalate(commitment, escalation)) {
        throw new InvalidStateTransitionError(`EscalationTriggered is not allowed for commitment ${commitment.id}`);
      }
      const nextCount = escalation.perCycleCount + 1;
      escalation.perCycleCount = nextCount;
      escalation.level = nextCount;
      escalation.lastEscalatedAt = command.now;
      escalation.status = nextCount >= 3 ? 'capped' : 'active';
      commitment.updatedAt = command.now;
      sideEffects.push({ type: 'send_escalation', commitmentId: commitment.id, level: nextCount });
      events.push(makeEvent('escalation_delivered', command.now, commitment.id, { level: nextCount }));
      didChange = true;
      break;
    }

    default: {
      const neverCommand: never = command;
      throw new InvalidStateTransitionError(`Unsupported command: ${JSON.stringify(neverCommand)}`);
    }
  }

  assertInvariants(newState);
  return { newState, events, sideEffects, didChange };
}

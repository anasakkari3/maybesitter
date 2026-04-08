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

export interface TimeSpec {
  kind: 'unscheduled' | 'due_by' | 'scheduled_event';
  dueAt: string | null;
  remindAt: string | null;
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

function defaultTimeSpec(timeSpec?: Partial<TimeSpec>): TimeSpec {
  if (timeSpec?.dueAt) ensureValidDate(timeSpec.dueAt, 'timeSpec.dueAt');
  if (timeSpec?.remindAt) ensureValidDate(timeSpec.remindAt, 'timeSpec.remindAt');

  return {
    kind: timeSpec?.kind || 'unscheduled',
    dueAt: timeSpec?.dueAt || null,
    remindAt: timeSpec?.remindAt || null,
    timezone: timeSpec?.timezone || 'UTC',
  };
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

import type { Item, ItemState } from '@/types';

export const ITEM_STATE_LABELS: Record<ItemState, string> = {
  captured: 'Captured',
  scheduled: 'Scheduled',
  reminder_pending: 'Reminder pending',
  reminder_sent: 'Reminder sent',
  acknowledged: 'Acknowledged',
  missed: 'Missed',
  escalation_pending: 'Escalation pending',
  escalated: 'Escalated',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const ALLOWED_ITEM_TRANSITIONS: Record<ItemState, ItemState[]> = {
  captured: ['scheduled', 'reminder_pending', 'acknowledged', 'completed', 'cancelled'],
  scheduled: ['captured', 'reminder_pending', 'reminder_sent', 'acknowledged', 'completed', 'cancelled'],
  reminder_pending: ['scheduled', 'reminder_sent', 'acknowledged', 'completed', 'cancelled'],
  reminder_sent: ['scheduled', 'acknowledged', 'missed', 'completed', 'cancelled'],
  acknowledged: ['scheduled', 'reminder_pending', 'completed', 'cancelled'],
  missed: ['scheduled', 'acknowledged', 'escalation_pending', 'completed', 'cancelled'],
  escalation_pending: ['scheduled', 'acknowledged', 'escalated', 'completed', 'cancelled'],
  escalated: ['scheduled', 'acknowledged', 'completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export function isTerminalState(state: ItemState): boolean {
  return state === 'completed' || state === 'cancelled';
}

export function isActiveState(state: ItemState): boolean {
  return !isTerminalState(state);
}

export function isAgendaItem(item: Item, todayIsoDate: string): boolean {
  if (!isActiveState(item.state)) return false;
  if (!item.dueDate) return false;
  return item.dueDate <= todayIsoDate;
}

export function canTransitionItem(from: ItemState, to: ItemState): boolean {
  return from === to || ALLOWED_ITEM_TRANSITIONS[from].includes(to);
}

export function assertValidItemTransition(from: ItemState, to: ItemState): void {
  if (!canTransitionItem(from, to)) {
    throw new Error(`Invalid item state transition: ${from} -> ${to}`);
  }
}

export function deriveScheduledState(dueDate?: string, reminderTime?: string): ItemState {
  return dueDate || reminderTime ? 'scheduled' : 'captured';
}

function transitionItem(
  item: Item,
  nextState: ItemState,
  updates: Partial<Item> = {},
  at: Date = new Date()
): Item {
  assertValidItemTransition(item.state, nextState);
  return {
    ...item,
    ...updates,
    state: nextState,
    updatedAt: at.toISOString(),
  };
}

export function scheduleItem(
  item: Item,
  updates: Pick<Partial<Item>, 'dueDate' | 'reminderTime' | 'roughTiming'> = {},
  at: Date = new Date()
): Item {
  if (isTerminalState(item.state)) {
    return {
      ...item,
      ...updates,
      state: item.state,
      updatedAt: at.toISOString(),
    };
  }

  const nextDueDate = updates.dueDate ?? item.dueDate;
  const nextReminderTime = updates.reminderTime ?? item.reminderTime;
  return transitionItem(
    item,
    deriveScheduledState(nextDueDate, nextReminderTime),
    {
      ...updates,
      acknowledgedAt: null,
      completedAt: null,
      escalationLevel: 0,
      escalatedAt: null,
    },
    at
  );
}

export function markReminderPending(item: Item, at: Date = new Date()): Item {
  return transitionItem(item, 'reminder_pending', {}, at);
}

export function markReminderSent(item: Item, at: Date = new Date()): Item {
  return transitionItem(item, 'reminder_sent', {}, at);
}

export function acknowledgeItem(item: Item, at: Date = new Date()): Item {
  if (isTerminalState(item.state)) {
    throw new Error('Cannot acknowledge a completed or cancelled item');
  }
  return transitionItem(
    item,
    'acknowledged',
    {
      acknowledgedAt: at.toISOString(),
      escalationLevel: 0,
      escalatedAt: null,
    },
    at
  );
}

export function markMissed(item: Item, at: Date = new Date()): Item {
  if (item.acknowledgedAt) {
    throw new Error('Cannot mark an acknowledged item as missed');
  }
  return transitionItem(item, 'missed', {}, at);
}

export function escalateItem(item: Item, at: Date = new Date()): Item {
  if (item.acknowledgedAt) {
    throw new Error('Cannot escalate an acknowledged item');
  }

  if (item.state === 'missed') {
    return markEscalationPending(item, at);
  }

  return transitionItem(
    item,
    'escalated',
    {
      escalationLevel: item.escalationLevel + 1,
      escalatedAt: at.toISOString(),
    },
    at
  );
}

export function markEscalationPending(item: Item, at: Date = new Date()): Item {
  if (item.acknowledgedAt) {
    throw new Error('Cannot mark an acknowledged item for escalation');
  }
  return transitionItem(item, 'escalation_pending', {}, at);
}

export function completeItem(item: Item, at: Date = new Date()): Item {
  return transitionItem(
    item,
    'completed',
    {
      completedAt: at.toISOString(),
    },
    at
  );
}

export function cancelItem(item: Item, at: Date = new Date()): Item {
  return transitionItem(item, 'cancelled', {}, at);
}

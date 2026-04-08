import test from 'node:test';
import assert from 'node:assert/strict';
import { getDailyAgenda } from '../lib/services/agendaService.ts';
import { clearPressureHistory, MemoryPressureDeliveryStore, recordPressureDelivery } from '../lib/services/pressureService.ts';
import { MemoryBehaviorFeedbackStore } from '../lib/services/behaviorFeedbackService.ts';
import { applyCommand, createEmptyDomainState } from '../src/domain/stateMachine.ts';
import { getDailyCalendarItems } from '../src/utils/agenda.ts';
import type { DomainState, Priority } from '../src/domain/stateMachine.ts';
import type { Item, ItemPriority, ItemState } from '../src/types/index.ts';

const now = new Date('2026-04-08T08:00:00.000Z');
const FORBIDDEN_PRESSURE_COPY = /Tracking|Drafted|Executed|You're set|20\d\d-\d\d-\d\d|avoidant|inconsistent|guilt|fault|shame/i;

function addDraft(
  state: DomainState,
  id: string,
  title: string,
  options: {
    dueAt?: string | null;
    remindAt?: string | null;
    status?: 'draft' | 'pending_confirmation' | 'needs_clarification';
    priority?: Partial<Priority>;
  } = {}
): DomainState {
  return applyCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T07:00:00.000Z',
    commitment: {
      id,
      kind: 'task',
      title,
      priority: options.priority,
      timeSpec: {
        kind: options.dueAt ? 'due_by' : 'unscheduled',
        dueAt: options.dueAt || null,
        remindAt: options.remindAt || options.dueAt || null,
        timezone: 'UTC',
      },
    },
    draftStatus: options.status || 'pending_confirmation',
  }).newState;
}

function confirm(state: DomainState, id: string, reminderAt?: string): DomainState {
  return applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: id,
    now: '2026-04-08T07:01:00.000Z',
    reminders: reminderAt ? [{ id: `rem_${id}`, scheduledFor: reminderAt }] : [],
  }).newState;
}

function makeCalendarItem(
  id: string,
  options: {
    priority?: ItemPriority;
    dueDate?: string;
    reminderTime?: string;
    state?: ItemState;
  } = {}
): Item {
  return {
    id,
    userId: 'demo-user',
    title: id,
    description: '',
    priority: options.priority || 'should',
    dueDate: options.dueDate || '',
    reminderTime: options.reminderTime || '',
    roughTiming: '',
    state: options.state || 'scheduled',
    acknowledgedAt: null,
    createdAt: '2026-04-08T07:00:00.000Z',
    updatedAt: '2026-04-08T07:00:00.000Z',
    completedAt: null,
    escalationLevel: 0,
    escalatedAt: null,
    source: 'text',
  };
}

test('agendaService: handles empty state gracefully', () => {
  const agenda = getDailyAgenda({ now }, createEmptyDomainState());

  assert.deepEqual(agenda, { items: [] });
});

test('daily calendar: timed items sort by time before untimed priority order', () => {
  const items = getDailyCalendarItems(
    [
      makeCalendarItem('untimed_nice', { priority: 'nice' }),
      makeCalendarItem('timed_17', { priority: 'nice', dueDate: '2026-04-08', reminderTime: '17:00' }),
      makeCalendarItem('untimed_must', { priority: 'must' }),
      makeCalendarItem('future', { priority: 'must', dueDate: '2026-04-09', reminderTime: '09:00' }),
      makeCalendarItem('timed_09', { priority: 'should', dueDate: '2026-04-08', reminderTime: '09:00' }),
      makeCalendarItem('completed', { priority: 'must', state: 'completed' }),
      makeCalendarItem('untimed_should', { priority: 'should' }),
    ],
    '2026-04-08'
  );

  assert.deepEqual(items.map((item) => item.id), [
    'timed_09',
    'timed_17',
    'untimed_must',
    'untimed_should',
    'untimed_nice',
  ]);
});

test('agendaService: returns ranked accountability agenda without duplicates', () => {
  let state = createEmptyDomainState();
  state = addDraft(state, 'overdue', 'Send invoice', { dueAt: '2026-04-08T07:30:00.000Z' });
  state = confirm(state, 'overdue', '2026-04-08T07:45:00.000Z');
  state = addDraft(state, 'pending', 'Confirm call with Maya', { dueAt: '2026-04-09T12:00:00.000Z' });
  state = addDraft(state, 'soon', 'Prepare notes', { dueAt: '2026-04-08T10:00:00.000Z' });
  state = confirm(state, 'soon', '2026-04-08T10:00:00.000Z');
  state = addDraft(state, 'active', 'Review lease', {
    status: 'pending_confirmation',
    priority: { level: 'high' },
  });
  state = confirm(state, 'active');

  const agenda = getDailyAgenda({ now }, state);

  assert.deepEqual(agenda.items.map((item) => item.id), ['overdue', 'soon', 'active', 'pending']);
  assert.deepEqual(agenda.items.map((item) => item.reason), ['overdue', 'due_soon', 'active', 'pending']);
  assert.deepEqual(agenda.items.map((item) => item.suggestedAction), ['do', 'do', 'review', 'confirm']);
  assert.equal(new Set(agenda.items.map((item) => item.id)).size, agenda.items.length);
  assert.ok(agenda.items[0].urgencyScore > agenda.items[1].urgencyScore);
});

test('agendaService: caps output and avoids low-priority active flooding', () => {
  let state = createEmptyDomainState();

  for (let index = 0; index < 8; index += 1) {
    const id = `pending_${index}`;
    state = addDraft(state, id, `Pending ${index}`, { dueAt: `2026-04-08T1${index}:00:00.000Z` });
  }

  state = addDraft(state, 'low_active', 'Organize drawer', {
    status: 'pending_confirmation',
    priority: { level: 'low' },
  });
  state = confirm(state, 'low_active');

  const agenda = getDailyAgenda({ now }, state);

  assert.equal(agenda.items.length, 7);
  assert.ok(agenda.items.every((item) => item.reason === 'pending'));
  assert.equal(agenda.pressureCandidate, undefined);
  assert.ok(!agenda.items.some((item) => item.id === 'low_active'));
});

test('agendaService: attaches read-only pressure candidate for high urgency agenda', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  const behaviorFeedbackStore = new MemoryBehaviorFeedbackStore();
  clearPressureHistory(deliveryStore);
  let state = createEmptyDomainState();
  state = addDraft(state, 'urgent_overdue', 'Send invoice', { dueAt: '2026-04-08T07:00:00.000Z' });
  state = confirm(state, 'urgent_overdue', '2026-04-08T07:00:00.000Z');

  const first = getDailyAgenda({ now, pressureDeliveryStore: deliveryStore, behaviorFeedbackStore }, state);
  const second = getDailyAgenda({ now, pressureDeliveryStore: deliveryStore, behaviorFeedbackStore }, state);
  const delivery = recordPressureDelivery('urgent_overdue', { now, deliveryStore }, state);
  const third = getDailyAgenda({ now, pressureDeliveryStore: deliveryStore, behaviorFeedbackStore }, state);

  assert.equal(first.pressureCandidate?.commitmentId, 'urgent_overdue');
  assert.equal(first.pressureCandidate?.tone, 'soft');
  assert.equal(first.pressureCandidate?.intensity, 'low');
  assert.match(first.pressureCandidate?.message || '', /send invoice/i);
  assert.doesNotMatch(first.pressureCandidate?.message || '', FORBIDDEN_PRESSURE_COPY);
  assert.equal(first.pressureCandidate?.strategy, 'easy_choice');
  assert.equal(typeof first.pressureCandidate?.path, 'string');
  assert.equal(second.pressureCandidate?.commitmentId, first.pressureCandidate?.commitmentId);
  assert.deepEqual(delivery, { success: true, message: 'Pressure delivery recorded.' });
  assert.equal(third.pressureCandidate, undefined);
});

test('agendaService: boosts ignored and repeatedly delayed active commitments deterministically', () => {
  let state = createEmptyDomainState();
  state = addDraft(state, 'plain', 'Plain active', {
    status: 'pending_confirmation',
    priority: { level: 'normal' },
  });
  state = confirm(state, 'plain');
  state = addDraft(state, 'ignored', 'Ignored active', {
    status: 'pending_confirmation',
    priority: { level: 'normal' },
  });
  state = confirm(state, 'ignored');
  state = addDraft(state, 'delayed', 'Delayed active', {
    status: 'pending_confirmation',
    priority: { level: 'normal' },
  });
  state = confirm(state, 'delayed');

  state.commitments.ignored = {
    ...state.commitments.ignored,
    currentAckState: 'ignored',
    updatedAt: '2026-04-08T07:50:00.000Z',
  };
  state.commitments.delayed = {
    ...state.commitments.delayed,
    currentAckState: 'postponed',
    postponedUntil: '2026-04-09T08:00:00.000Z',
  };
  state.reminders.snoozed_delayed = {
    id: 'snoozed_delayed',
    commitmentId: 'delayed',
    reminderType: 'check_in',
    scheduledFor: '2026-04-09T08:00:00.000Z',
    status: 'snoozed',
    requiresAction: true,
    deliveredAt: '2026-04-08T07:30:00.000Z',
    acknowledgedAt: null,
    snoozedUntil: '2026-04-09T08:00:00.000Z',
    createdAt: '2026-04-08T07:00:00.000Z',
    updatedAt: '2026-04-08T07:40:00.000Z',
  };

  const first = getDailyAgenda({ now }, state);
  const second = getDailyAgenda({ now }, state);

  assert.deepEqual(first, second);
  assert.deepEqual(first.items.map((item) => item.id), ['delayed', 'ignored', 'plain']);
  assert.ok(first.items[0].urgencyScore > first.items[1].urgencyScore);
  assert.ok(first.items[1].urgencyScore > first.items[2].urgencyScore);
});

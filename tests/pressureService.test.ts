import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgendaItem } from '../lib/services/agendaService.ts';
import { MemoryBehaviorFeedbackStore } from '../lib/services/behaviorFeedbackService.ts';
import {
  clearPressureHistory,
  FilePressureDeliveryStore,
  getPressureCandidateForAgenda,
  getPressureMessageForAgenda,
  MemoryPressureDeliveryStore,
  recordPressureDelivery,
} from '../lib/services/pressureService.ts';
import type { ResponsePlan, ResponseStrategy } from '../lib/services/responseEngine/assistantTurn.ts';
import { realizeResponsePlan } from '../lib/services/responseEngine/realization.ts';
import { validateResponsePlanAndMessage } from '../lib/services/responseEngine/validation.ts';
import { applyCommand, createEmptyDomainState, type DomainState } from '../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');
const FORBIDDEN_PRESSURE_COPY = /guilt|fault|disappointed|shame|avoidant|inconsistent|Tracking|Drafted|Executed|20\d\d-\d\d-\d\d/i;

function assertPressureCopy(message: string | undefined): string {
  assert.equal(typeof message, 'string');
  const value = message || '';
  assert.notEqual(value.trim(), '');
  assert.doesNotMatch(value, FORBIDDEN_PRESSURE_COPY);
  assert.doesNotMatch(value, /\b(done|complete|saved|marked)\b/i);
  return value;
}

function assertPressureStrategyCopy(strategy: ResponseStrategy | undefined, message: string | undefined): string {
  const value = assertPressureCopy(message);
  if (strategy === 'easy_choice') {
    assert.match(value, /keep it for today|move it\?|do it|handle it today/i);
    assert.doesNotMatch(value, /blocking|blocker|stuck|reset|finish it|drop it/i);
  }
  if (strategy === 'smaller_step') {
    assert.match(value, /smaller next step|manageable step|make it smaller|next manageable step/i);
    assert.doesNotMatch(value, /blocking|blocker|stuck|keep it for today|reset|finish it|drop it/i);
  }
  if (strategy === 'blocker_probe') {
    assert.match(value, /blocking|blocker|stuck|what's blocking|what is blocking/i);
    assert.doesNotMatch(value, /keep it for today|finish it|drop it|reset the plan|smaller next step/i);
  }
  if (strategy === 'reset_plan') {
    assert.match(value, /reset|replan|plan/i);
    assert.doesNotMatch(value, /blocking|blocker|stuck|keep it for today|finish it|drop it/i);
  }
  if (strategy === 'close_loop') {
    assert.match(value, /finish it|drop it|still open/i);
    assert.doesNotMatch(value, /blocking|blocker|stuck|keep it for today|smaller next step|reset/i);
  }
  return value;
}

function pressurePlan(strategy: ResponseStrategy): ResponsePlan {
  const movesByStrategy: Record<string, ResponsePlan['moves']> = {
    easy_choice: ['name_continuity', 'offer_small_step'],
    smaller_step: ['name_continuity', 'offer_small_step'],
    blocker_probe: ['name_continuity', 'probe_blocker'],
    reset_plan: ['name_continuity', 'offer_reset'],
    close_loop: ['name_continuity', 'force_choice'],
  };
  return {
    intent: strategy === 'blocker_probe' ? 'probe_blocker' : strategy === 'reset_plan' ? 'reset_plan' : strategy === 'close_loop' ? 'escalate_choice' : 'nudge',
    strategy,
    moves: movesByStrategy[strategy] || ['name_continuity', 'offer_small_step'],
    facts: {
      title: 'Call Maya',
      continuityText: 'Call Maya has come back twice',
    },
    constraints: {
      tone: strategy === 'easy_choice' ? 'light_check' : strategy === 'close_loop' || strategy === 'reset_plan' ? 'firm' : 'direct',
      maxSentences: 2,
      requireQuestion: strategy === 'easy_choice' || strategy === 'blocker_probe',
      forbiddenTerms: [],
    },
  };
}

function emptyConversationState() {
  return {
    pathCounts: {},
    moveCounts: {},
    lastPathsByIntent: {},
    recentPaths: [],
    recentInteractionCount: 0,
    recentClarificationCount: 0,
    recentNoResponseCount: 0,
    recentCompletionCount: 0,
    recentDeferralCount: 0,
    responsiveness: 'unknown' as const,
    fatigue: 'low' as const,
  };
}

function openerFamily(message: string): string {
  if (/^Call Maya has come back/i.test(message)) return 'continuity';
  if (/^Decide on/i.test(message)) return 'decision';
  if (/^For /i.test(message)) return 'time';
  if (/looks stuck/i.test(message)) return 'blocker';
  if (/^What's blocking/i.test(message)) return 'direct-question';
  if (/^The plan/i.test(message)) return 'reset';
  if (/^Call Maya is still open/i.test(message)) return 'direct-close';
  return 'other';
}

function addConfirmedCommitment(
  state: DomainState,
  id: string,
  title: string,
  options: {
    dueAt?: string;
    remindAt?: string;
    pressureAllowed?: boolean;
    kind?: 'task' | 'follow_up';
  } = {}
): DomainState {
  state = applyCommand(state, {
    type: 'CreateDraft',
    now: '2026-04-08T06:00:00.000Z',
    commitment: {
      id,
      kind: options.kind || 'task',
      title,
      priority: {
        level: 'normal',
        pressureAllowed: options.pressureAllowed,
      },
      timeSpec: {
        kind: options.dueAt ? 'due_by' : 'unscheduled',
        dueAt: options.dueAt || null,
        remindAt: options.remindAt || null,
        timezone: 'UTC',
      },
    },
    draftStatus: 'pending_confirmation',
  }).newState;

  return applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: id,
    now: '2026-04-08T06:01:00.000Z',
    reminders: [],
  }).newState;
}

function item(id: string, options: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id,
    title: options.title || 'Agenda item',
    reason: options.reason || 'overdue',
    urgencyScore: options.urgencyScore || 7_000,
    suggestedAction: options.suggestedAction || 'do',
  };
}

test('pressureService: empty state produces no pressure', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);

  const result = getPressureMessageForAgenda([], { now, deliveryStore }, createEmptyDomainState());

  assert.deepEqual(result, { message: '', tone: 'soft', intensity: 'low' });
});

test('pressureService: overdue commitment gets soft pressure', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  const state = addConfirmedCommitment(createEmptyDomainState(), 'overdue', 'Send invoice', {
    dueAt: '2026-04-08T07:00:00.000Z',
  });

  const result = getPressureCandidateForAgenda([item('overdue', { title: 'Send invoice' })], { now, deliveryStore }, state);

  assert.equal(result?.commitmentId, 'overdue');
  assert.equal(result?.tone, 'soft');
  assert.equal(result?.intensity, 'low');
  assert.equal(result?.strategy, 'easy_choice');
  assert.match(assertPressureStrategyCopy(result?.strategy, result?.message), /send invoice/i);
  assert.equal(typeof result?.path, 'string');
});

test('pressureService: repeated ignored reminders get balanced pressure for inconsistent behavior', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  let state = addConfirmedCommitment(createEmptyDomainState(), 'ignored', 'Call Maya');
  state.reminders.first = {
    id: 'first',
    commitmentId: 'ignored',
    reminderType: 'check_in',
    scheduledFor: '2026-04-08T06:30:00.000Z',
    status: 'ignored',
    requiresAction: true,
    deliveredAt: '2026-04-08T06:30:00.000Z',
    acknowledgedAt: null,
    snoozedUntil: null,
    createdAt: '2026-04-08T06:00:00.000Z',
    updatedAt: '2026-04-08T06:45:00.000Z',
  };
  state.reminders.second = {
    ...state.reminders.first,
    id: 'second',
    scheduledFor: '2026-04-08T07:00:00.000Z',
    deliveredAt: '2026-04-08T07:00:00.000Z',
    updatedAt: '2026-04-08T07:15:00.000Z',
  };
  state.commitments.ignored = {
    ...state.commitments.ignored,
    currentAckState: 'ignored',
    updatedAt: '2026-04-08T07:15:00.000Z',
  };

  const result = getPressureCandidateForAgenda([
    item('ignored', { title: 'Call Maya', reason: 'active', urgencyScore: 3_500, suggestedAction: 'review' }),
  ], { now, deliveryStore }, state);

  assert.equal(result?.tone, 'soft');
  assert.equal(result?.intensity, 'medium');
  assert.match(assertPressureStrategyCopy(result?.strategy, result?.message), /call Maya/i);
  assert.doesNotMatch(result?.message || '', /missed 2 times|honest step/i);
});

test('pressureService: avoidant behavior gets firm but non-shaming pressure', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  const state = addConfirmedCommitment(createEmptyDomainState(), 'ignored', 'Call Maya', {
    dueAt: '2026-04-08T06:00:00.000Z',
  });

  const result = getPressureCandidateForAgenda([
    item('ignored', { title: 'Call Maya', reason: 'overdue', urgencyScore: 7_000, suggestedAction: 'do' }),
  ], {
    now,
    deliveryStore,
    adaptiveSignals: {
      ignoredCommitmentsCount: 3,
      completionRate: 0.8,
      delayFrequency: 0.1,
      clarificationFrequency: 0,
    },
  }, state);

  assert.equal(result?.tone, 'firm');
  assert.equal(result?.intensity, 'high');
  assert.equal(result?.strategy, 'blocker_probe');
  assert.match(assertPressureStrategyCopy(result?.strategy, result?.message), /call Maya/i);
});

test('pressureService: blocker probe cannot realize easy-choice pressure language', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  const state = addConfirmedCommitment(createEmptyDomainState(), 'ignored', 'Call Maya', {
    dueAt: '2026-04-08T06:00:00.000Z',
  });

  const result = getPressureCandidateForAgenda([
    item('ignored', { title: 'Call Maya', reason: 'overdue', urgencyScore: 7_000, suggestedAction: 'do' }),
  ], {
    now,
    sessionId: 'blocker-regression',
    deliveryStore,
    adaptiveSignals: {
      ignoredCommitmentsCount: 3,
      completionRate: 0.8,
      delayFrequency: 0.1,
      clarificationFrequency: 0,
    },
  }, state);

  assert.equal(result?.strategy, 'blocker_probe');
  assert.match(assertPressureStrategyCopy(result?.strategy, result?.message), /call Maya/i);
  assert.doesNotMatch(result?.message || '', /keep it for today|move it\?/i);
});

test('pressureService: pressure validation rejects strategy-incompatible messages', () => {
  const blockerWithEasyChoice = validateResponsePlanAndMessage(
    pressurePlan('blocker_probe'),
    'Call Maya has come back twice. Keep it for today or move it?'
  );
  const easyChoiceWithBlocker = validateResponsePlanAndMessage(
    pressurePlan('easy_choice'),
    "Call Maya has come back twice. What's blocking it?"
  );
  const smallerStepWithBlocker = validateResponsePlanAndMessage(
    pressurePlan('smaller_step'),
    "Call Maya has come back twice. What's blocking it?"
  );
  const resetWithEasyChoice = validateResponsePlanAndMessage(
    pressurePlan('reset_plan'),
    'Call Maya has come back twice. Keep it for today or move it?'
  );
  const closeLoopWithSmallStep = validateResponsePlanAndMessage(
    pressurePlan('close_loop'),
    'Call Maya has come back twice. Pick a smaller next step or move it.'
  );

  assert.equal(blockerWithEasyChoice.ok, false);
  assert.equal(easyChoiceWithBlocker.ok, false);
  assert.equal(smallerStepWithBlocker.ok, false);
  assert.equal(resetWithEasyChoice.ok, false);
  assert.equal(closeLoopWithSmallStep.ok, false);
});

test('pressureService: pressure realization composes multiple opener and move structures per strategy', () => {
  const strategies: ResponseStrategy[] = ['easy_choice', 'smaller_step', 'blocker_probe', 'reset_plan', 'close_loop'];

  for (const strategy of strategies) {
    const realized = [0.01, 0.48, 0.99].map((entropy) => realizeResponsePlan(pressurePlan(strategy), {
      conversationState: emptyConversationState(),
      entropy: () => entropy,
    }));
    const paths = new Set(realized.map((item) => item.path));
    const openers = new Set(realized.map((item) => openerFamily(item.message)));

    assert.ok(paths.size >= 2, `${strategy} should expose more than one pressure composition path`);
    assert.ok(openers.size >= 2, `${strategy} should vary opener structure`);
    for (const item of realized) {
      assertPressureStrategyCopy(strategy, item.message);
    }
  }
});

test('pressureService: pressure realization keeps each strategy inside its compatible path family', () => {
  const allowedPaths: Record<ResponseStrategy, Set<string>> = {
    direct_result: new Set(),
    focused_question: new Set(),
    careful_confirm: new Set(),
    context_boundary: new Set(),
    multi_summary: new Set(),
    easy_choice: new Set(['continuity_choice', 'pressure_decision_choice', 'pressure_time_choice']),
    smaller_step: new Set(['continuity_small_step', 'pressure_direct_small_step', 'time_first_commitment']),
    blocker_probe: new Set(['continuity_blocker', 'pressure_blocker_first', 'direct_question']),
    reset_plan: new Set(['continuity_reset', 'pressure_reset_first', 'pressure_decision_reset']),
    close_loop: new Set(['decision_close', 'pressure_close_direct']),
  };
  const strategies: ResponseStrategy[] = ['easy_choice', 'smaller_step', 'blocker_probe', 'reset_plan', 'close_loop'];

  for (const strategy of strategies) {
    for (const entropy of [0.01, 0.33, 0.66, 0.99]) {
      const realized = realizeResponsePlan(pressurePlan(strategy), {
        conversationState: emptyConversationState(),
        entropy: () => entropy,
      });
      assert.ok(allowedPaths[strategy].has(realized.path), `${strategy} realized incompatible path ${realized.path}`);
      assertPressureStrategyCopy(strategy, realized.message);
    }
  }
});

test('pressureService: evaluation does not consume cooldown until delivery is recorded', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  const state = addConfirmedCommitment(createEmptyDomainState(), 'overdue', 'Send invoice', {
    dueAt: '2026-04-08T07:00:00.000Z',
  });

  const agendaItems = [item('overdue', { title: 'Send invoice' })];
  const first = getPressureCandidateForAgenda(agendaItems, { now, deliveryStore }, state);
  const second = getPressureCandidateForAgenda(agendaItems, { now, deliveryStore }, state);
  const recorded = recordPressureDelivery('overdue', { now, deliveryStore, surfacedMessage: first?.message }, state);
  const third = getPressureCandidateForAgenda(agendaItems, { now, deliveryStore }, state);

  assert.notEqual(first?.message, '');
  assert.equal(second?.commitmentId, first?.commitmentId);
  assert.equal(second?.strategy, first?.strategy);
  assertPressureStrategyCopy(second?.strategy, second?.message);
  assert.deepEqual(recorded, { success: true, message: 'Pressure delivery recorded.' });
  assert.equal(third, null);
});

test('pressureService: avoids identical back-to-back pressure messages after delivery', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  const state = addConfirmedCommitment(createEmptyDomainState(), 'overdue', 'Send invoice', {
    dueAt: '2026-04-08T07:00:00.000Z',
  });
  const agendaItems = [item('overdue', { title: 'Send invoice' })];

  const first = getPressureCandidateForAgenda(agendaItems, { now, deliveryStore }, state);
  recordPressureDelivery('overdue', {
    now,
    cooldownMs: 0,
    deliveryStore,
    surfacedMessage: first?.message,
    surfacedStrategy: first?.strategy,
    surfacedPath: first?.path,
  }, state);
  const second = getPressureCandidateForAgenda(agendaItems, { now, cooldownMs: 0, deliveryStore }, state);

  assertPressureStrategyCopy(first?.strategy, first?.message);
  assertPressureStrategyCopy(second?.strategy, second?.message);
  assert.notEqual(first?.path, second?.path);
});

test('pressureService: message context reflects long delays and follow-up commitments', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  let state = addConfirmedCommitment(createEmptyDomainState(), 'long_delay', 'Send invoice', {
    dueAt: '2026-04-06T08:00:00.000Z',
  });
  state = addConfirmedCommitment(state, 'follow_up', 'Email Sam', {
    dueAt: '2026-04-08T07:00:00.000Z',
    kind: 'follow_up',
  });

  const longDelay = getPressureCandidateForAgenda(
    [item('long_delay', { title: 'Send invoice', urgencyScore: 7_000 })],
    { now, deliveryStore },
    state
  );
  const followUp = getPressureCandidateForAgenda(
    [item('follow_up', { title: 'Email Sam', urgencyScore: 7_000 })],
    { now, deliveryStore },
    state
  );

  assert.match(assertPressureStrategyCopy(longDelay?.strategy, longDelay?.message), /send invoice/i);
  assert.match(assertPressureStrategyCopy(followUp?.strategy, followUp?.message), /email Sam/i);
  assert.notEqual(longDelay?.message, followUp?.message);
});

test('pressureService: persisted delivery metadata survives store recreation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-pressure-'));
  try {
    const filePath = join(dir, 'pressure.json');
    const state = addConfirmedCommitment(createEmptyDomainState(), 'overdue', 'Send invoice', {
      dueAt: '2026-04-08T07:00:00.000Z',
    });
    const agendaItems = [item('overdue', { title: 'Send invoice' })];
    const firstStore = new FilePressureDeliveryStore(filePath);
    const first = getPressureCandidateForAgenda(agendaItems, {
      now,
      sessionId: 'session-a',
      deliveryStore: firstStore,
    }, state);
    const recorded = recordPressureDelivery('overdue', {
      now,
      sessionId: 'session-a',
      deliveryStore: firstStore,
      surfacedMessage: first?.message,
      surfacedStrategy: first?.strategy,
      surfacedPath: first?.path,
    }, state);
    const secondStore = new FilePressureDeliveryStore(filePath);
    const afterRestart = getPressureCandidateForAgenda(agendaItems, {
      now,
      sessionId: 'session-a',
      deliveryStore: secondStore,
    }, state);

    assert.equal(first?.commitmentId, 'overdue');
    assert.deepEqual(recorded, { success: true, message: 'Pressure delivery recorded.' });
    assert.equal(afterRestart, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pressureService: persisted path history survives restart-like store recreation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-pressure-history-'));
  try {
    const filePath = join(dir, 'pressure.json');
    const state = addConfirmedCommitment(createEmptyDomainState(), 'overdue', 'Send invoice', {
      dueAt: '2026-04-08T07:00:00.000Z',
    });
    const agendaItems = [item('overdue', { title: 'Send invoice' })];

    const firstStore = new FilePressureDeliveryStore(filePath);
    const first = getPressureCandidateForAgenda(agendaItems, {
      now,
      sessionId: 'session-history',
      cooldownMs: 0,
      deliveryStore: firstStore,
    }, state);
    recordPressureDelivery('overdue', {
      now,
      sessionId: 'session-history',
      cooldownMs: 0,
      deliveryStore: firstStore,
      surfacedMessage: first?.message,
      surfacedStrategy: first?.strategy,
      surfacedPath: first?.path,
    }, state);

    const secondStore = new FilePressureDeliveryStore(filePath);
    const second = getPressureCandidateForAgenda(agendaItems, {
      now,
      sessionId: 'session-history',
      cooldownMs: 0,
      deliveryStore: secondStore,
    }, state);
    recordPressureDelivery('overdue', {
      now,
      sessionId: 'session-history',
      cooldownMs: 0,
      deliveryStore: secondStore,
      surfacedMessage: second?.message,
      surfacedStrategy: second?.strategy,
      surfacedPath: second?.path,
    }, state);

    const thirdStore = new FilePressureDeliveryStore(filePath);
    const record = thirdStore.getLastRecord('session-history', 'overdue');
    const third = getPressureCandidateForAgenda(agendaItems, {
      now,
      sessionId: 'session-history',
      cooldownMs: 0,
      deliveryStore: thirdStore,
    }, state);

    assert.equal(record?.path, second?.path);
    assert.deepEqual(record?.recentPaths, [first?.path, second?.path].filter(Boolean));
    assert.notEqual(third?.path, second?.path);
    assertPressureStrategyCopy(third?.strategy, third?.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pressureService: delivery cooldown is isolated by session scope', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  const state = addConfirmedCommitment(createEmptyDomainState(), 'overdue', 'Send invoice', {
    dueAt: '2026-04-08T07:00:00.000Z',
  });
  const agendaItems = [item('overdue', { title: 'Send invoice' })];

  recordPressureDelivery('overdue', { now, sessionId: 'session-a', deliveryStore }, state);
  const sameSession = getPressureCandidateForAgenda(agendaItems, { now, sessionId: 'session-a', deliveryStore }, state);
  const otherSession = getPressureCandidateForAgenda(agendaItems, { now, sessionId: 'session-b', deliveryStore }, state);

  assert.equal(sameSession, null);
  assert.equal(otherSession?.commitmentId, 'overdue');
});

test('pressureService: acknowledged or postponed items do not get pressured', () => {
  const deliveryStore = new MemoryPressureDeliveryStore();
  clearPressureHistory(deliveryStore);
  let state = addConfirmedCommitment(createEmptyDomainState(), 'aware', 'Send invoice', {
    dueAt: '2026-04-08T07:00:00.000Z',
  });
  state.commitments.aware = {
    ...state.commitments.aware,
    currentAckState: 'aware',
  };

  const result = getPressureMessageForAgenda([item('aware', { title: 'Send invoice' })], { now, deliveryStore }, state);

  assert.deepEqual(result, { message: '', tone: 'soft', intensity: 'low' });
});

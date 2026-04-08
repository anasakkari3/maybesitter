import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatResponse } from '../lib/services/responseFormatter.ts';
import { createAssistantTurn } from '../lib/services/responseEngine/assistantTurn.ts';
import type { ResponsePlan, ResponseStrategy } from '../lib/services/responseEngine/assistantTurn.ts';
import { MemoryConversationStateStore } from '../lib/services/responseEngine/conversationStateStore.ts';
import { validateResponsePlanAndMessage } from '../lib/services/responseEngine/validation.ts';

const now = new Date('2026-04-08T08:00:00.000Z');
const FORBIDDEN_COPY = /Tracking|Drafted|Executed|You're set|\bcommand\b|\bdisposition\b|20\d\d-\d\d-\d\d|avoidant|inconsistent/i;

function assertSafeVisibleCopy(message: string): void {
  assert.notEqual(message.trim(), '');
  assert.doesNotMatch(message, FORBIDDEN_COPY);
  assert.doesNotMatch(message, /;/);
}

function validationPlan(overrides: Partial<ResponsePlan> = {}): ResponsePlan {
  return {
    intent: 'confirm_result',
    strategy: 'direct_result',
    moves: ['confirm_action'],
    facts: {
      title: 'Send invoice',
      titleLower: 'send invoice',
      titleCapitalized: 'Send invoice',
      stateChange: 'completed',
    },
    constraints: {
      tone: 'quiet',
      maxSentences: 2,
      requireQuestion: false,
      forbiddenTerms: [],
    },
    ...overrides,
    facts: {
      title: 'Send invoice',
      titleLower: 'send invoice',
      titleCapitalized: 'Send invoice',
      stateChange: 'completed',
      ...overrides.facts,
    },
    constraints: {
      tone: 'quiet',
      maxSentences: 2,
      requireQuestion: false,
      forbiddenTerms: [],
      ...overrides.constraints,
    },
  };
}

function pressureValidationPlan(strategy: ResponseStrategy): ResponsePlan {
  const movesByStrategy: Partial<Record<ResponseStrategy, ResponsePlan['moves']>> = {
    easy_choice: ['name_continuity', 'offer_small_step'],
    blocker_probe: ['name_continuity', 'probe_blocker'],
    smaller_step: ['name_continuity', 'offer_small_step'],
    reset_plan: ['name_continuity', 'offer_reset'],
    close_loop: ['name_continuity', 'force_choice'],
  };
  return validationPlan({
    intent: strategy === 'blocker_probe' ? 'probe_blocker' : strategy === 'reset_plan' ? 'reset_plan' : strategy === 'close_loop' ? 'escalate_choice' : 'nudge',
    strategy,
    moves: movesByStrategy[strategy] || ['name_continuity', 'offer_small_step'],
    facts: {
      title: 'Call Maya',
      titleLower: 'call Maya',
      titleCapitalized: 'Call Maya',
      stateChange: undefined,
      continuityText: 'Call Maya has come back twice',
    },
    constraints: {
      tone: strategy === 'easy_choice' ? 'light_check' : 'direct',
      requireQuestion: strategy === 'easy_choice' || strategy === 'blocker_probe',
    },
  });
}

test('responseFormatter: creation uses V3 assistant message and no production scaffold fields', () => {
  const response = formatResponse({
    disposition: 'auto_confirm',
    result: { type: 'task', title: 'Call Maya', remindAt: '2026-04-09T18:00:00.000Z' },
    commands: [
      { type: 'CreateDraft', commitment: { title: 'Call Maya' } },
      { type: 'ConfirmCommitment', reminders: [{}] },
    ],
    commandResults: [{ result: 'applied' }, { result: 'applied' }],
    now,
  });

  assertSafeVisibleCopy(response.message);
  assert.match(response.message, /tomorrow at 6 PM|Call Maya|call Maya/i);
  assert.equal(response.interpretation, '');
  assert.deepEqual(response.actions, []);
  assert.deepEqual(response.nextStep, { type: 'none', message: '' });
  assert.equal(response.assistantTurn?.plan.intent, 'confirm_result');
});

test('responseFormatter: clarification asks for the missing semantic detail', () => {
  const missingTime = formatResponse({
    disposition: 'needs_clarification',
    result: { type: 'task', title: 'Call mom', missingFields: ['time'] },
    now,
  });
  const missingAction = formatResponse({
    disposition: 'needs_clarification',
    result: { type: 'task', remindAt: '2026-04-09T18:00:00.000Z', missingFields: ['action'] },
    now,
  });
  const missingPerson = formatResponse({
    disposition: 'needs_clarification',
    result: { type: 'follow_up', title: 'Follow up', missingFields: ['person'] },
    now,
  });

  for (const response of [missingTime, missingAction, missingPerson]) {
    assertSafeVisibleCopy(response.message);
    assert.equal(response.nextStep.type, 'clarify');
    assert.match(response.message, /\?/);
  }
  assert.match(missingTime.message, /when|what time|date/i);
  assert.match(missingAction.message, /what/i);
  assert.match(missingPerson.message, /who/i);
});

test('responseFormatter: no-op and unsafe paths do not imply persistence', () => {
  const store = new MemoryConversationStateStore();
  const informational = createAssistantTurn({
    event: { type: 'informational_no_change', title: 'Maya is waiting on the invoice' },
    now,
    store,
    record: false,
    realization: { entropy: () => 0.01 },
  });
  const rejected = formatResponse({
    disposition: 'auto_confirm',
    result: { type: 'task', title: 'Call Maya' },
    commands: [{ type: 'CreateDraft', commitment: { title: 'Call Maya' } }],
    commandResults: [{ result: 'rejected' }],
    now,
  });

  assertSafeVisibleCopy(informational.message);
  assert.doesNotMatch(informational.message, /\b(saved|created|scheduled|done)\b/i);
  assert.equal(informational.plan.facts.stateChange, 'none');
  assertSafeVisibleCopy(rejected.message);
  assert.doesNotMatch(rejected.message, /\b(saved|created|scheduled|done)\b/i);
  assert.equal(rejected.assistantTurn?.plan.facts.stateChange, 'none');
  assert.match(rejected.message, /safe|unchanged|change/i);
});

test('responseFormatter: state transitions drive the visible meaning without creation leakage', () => {
  const samples = [
    formatResponse({
      disposition: 'auto_confirm',
      result: { type: 'task', title: 'Send invoice' },
      commands: [{ type: 'Complete' }],
      commandResults: [{ result: 'applied' }],
      now,
    }),
    formatResponse({
      disposition: 'auto_confirm',
      result: { type: 'task', title: 'Send invoice' },
      commands: [{ type: 'MarkAware' }],
      commandResults: [{ result: 'applied' }],
      now,
    }),
    formatResponse({
      disposition: 'auto_confirm',
      result: { type: 'task', title: 'Send invoice' },
      commands: [{ type: 'Postpone', postponedUntil: '2026-04-09T08:00:00.000Z' }],
      commandResults: [{ result: 'applied' }],
      now,
    }),
    formatResponse({
      disposition: 'auto_confirm',
      result: { type: 'task', title: 'Send invoice' },
      commands: [{ type: 'Drop' }],
      commandResults: [{ result: 'applied' }],
      now,
    }),
    formatResponse({
      disposition: 'auto_confirm',
      result: { type: 'task', title: 'Send invoice' },
      commands: [{ type: 'UpdateCommitment', updates: { timeSpec: { remindAt: '2026-04-10T09:30:00.000Z' } } }],
      commandResults: [{ result: 'applied' }],
      now,
    }),
  ];

  for (const response of samples) {
    assertSafeVisibleCopy(response.message);
    assert.doesNotMatch(response.message, /\btrack|tracking|drafted|executed\b/i);
  }
  assert.doesNotMatch(samples[0].message, /\bremind|save|schedule\b/i);
  assert.match(samples[2].message, /tomorrow|Apr|moved|now/i);
  assert.match(samples[3].message, /cancel|off the active list/i);
});

test('responseFormatter: confirmation requests remain questions and do not claim completion', () => {
  const response = formatResponse({
    disposition: 'pending_confirmation',
    result: { type: 'follow_up', title: 'Follow up with Daniel about lease' },
    commands: [{ type: 'CreateDraft', commitment: { title: 'Follow up with Daniel about lease' } }],
    commandResults: [{ result: 'applied' }],
    now,
  });

  assertSafeVisibleCopy(response.message);
  assert.match(response.message, /\?/);
  assert.doesNotMatch(response.message, /\b(done|complete|moved|cancelled)\b/i);
  assert.equal(response.nextStep.type, 'confirm');
});

test('responseEngine: phrase normalization prevents known malformed reminder forms', () => {
  const store = new MemoryConversationStateStore();
  const creationTurns = [0.01, 0.45, 0.99].map((entropy) => createAssistantTurn({
    event: { type: 'reminder_created', title: 'Call Maya', remindAt: '2026-04-09T18:00:00.000Z' },
    now,
    store,
    record: false,
    realization: { entropy: () => entropy },
  }));
  const confirmation = formatResponse({
    disposition: 'pending_confirmation',
    result: { type: 'follow_up', title: 'Follow up with Daniel about lease' },
    commands: [{ type: 'CreateDraft', commitment: { title: 'Follow up with Daniel about lease' } }],
    commandResults: [{ result: 'applied' }],
    now,
  });
  const informational = createAssistantTurn({
    event: { type: 'informational_no_change', title: 'Maya is waiting on the invoice' },
    now,
    store,
    record: false,
    realization: { entropy: () => 0.01 },
  });

  for (const turn of creationTurns) {
    assertSafeVisibleCopy(turn.message);
    assert.doesNotMatch(turn.message, /at tomorrow at/i);
    assert.doesNotMatch(turn.message, /reminder for call Maya/i);
  }
  assert.doesNotMatch(confirmation.message, /about lease/i);
  assert.doesNotMatch(confirmation.message, /reminder for follow up/i);
  assert.match(confirmation.message, /about the lease/i);
  assert.doesNotMatch(informational.message, /maya is waiting/);
  assert.match(informational.message, /Maya is waiting/);
});

test('responseEngine: semantic validation rejects contradictory state language', () => {
  const completionSavedReminder = validateResponsePlanAndMessage(
    validationPlan(),
    'Saved a reminder for send invoice.'
  );
  const completionWillRemind = validateResponsePlanAndMessage(
    validationPlan(),
    "Done, I'll remind you about send invoice."
  );
  const succeededButNoChange = validateResponsePlanAndMessage(
    validationPlan({ facts: { stateChange: 'completed' } }),
    "I didn't change anything."
  );
  const pressureClaimsCompletion = validateResponsePlanAndMessage(
    pressureValidationPlan('easy_choice'),
    'Call Maya is complete.'
  );
  const blockerProbeEasyChoice = validateResponsePlanAndMessage(
    pressureValidationPlan('blocker_probe'),
    'Call Maya has come back twice. Keep it for today or move it?'
  );

  assert.equal(completionSavedReminder.ok, false);
  assert.match(completionSavedReminder.errors.join(' | '), /completion resembles creation or tracking/);
  assert.equal(completionWillRemind.ok, false);
  assert.match(completionWillRemind.errors.join(' | '), /completion resembles creation or tracking/);
  assert.equal(succeededButNoChange.ok, false);
  assert.match(succeededButNoChange.errors.join(' | '), /applied state change cannot use no-change language|completion cannot claim no change/);
  assert.equal(pressureClaimsCompletion.ok, false);
  assert.match(pressureClaimsCompletion.errors.join(' | '), /pressure claims a state change/);
  assert.equal(blockerProbeEasyChoice.ok, false);
  assert.match(blockerProbeEasyChoice.errors.join(' | '), /blocker_probe pressure realized easy-choice language/);
});

test('responseEngine: non-pressure clause realization varies without known malformed grammar', () => {
  const store = new MemoryConversationStateStore();
  const samples = [
    ...[0.01, 0.35, 0.7, 0.99].map((entropy) => createAssistantTurn({
      event: { type: 'reminder_created', title: 'Call Maya', remindAt: '2026-04-09T18:00:00.000Z' },
      now,
      store,
      record: false,
      realization: { entropy: () => entropy },
    })),
    ...[0.01, 0.35, 0.7, 0.99].map((entropy) => createAssistantTurn({
      event: { type: 'commitment_moved', title: 'Send invoice', movedTo: '2026-04-09T08:00:00.000Z' },
      now,
      store,
      record: false,
      realization: { entropy: () => entropy },
    })),
    ...[0.01, 0.35, 0.7, 0.99].map((entropy) => createAssistantTurn({
      event: { type: 'needs_clarification', missing: 'time', title: 'Call mom' },
      now,
      store,
      record: false,
      realization: { entropy: () => entropy },
    })),
    ...[0.01, 0.35, 0.7, 0.99].map((entropy) => createAssistantTurn({
      event: { type: 'confirmation_needed', title: 'Follow up with Daniel about lease' },
      now,
      store,
      record: false,
      realization: { entropy: () => entropy },
    })),
    ...[0.01, 0.35, 0.7, 0.99].map((entropy) => createAssistantTurn({
      event: { type: 'informational_no_change', title: 'Maya is waiting on the invoice' },
      now,
      store,
      record: false,
      realization: { entropy: () => entropy },
    })),
  ];
  const pathsByIntent = new Map<string, Set<string | undefined>>();

  for (const sample of samples) {
    assertSafeVisibleCopy(sample.message);
    assert.doesNotMatch(sample.message, /\bDone, i\b/);
    assert.doesNotMatch(sample.message, /at tomorrow at/i);
    assert.doesNotMatch(sample.message, /reminder for call Maya/i);
    assert.doesNotMatch(sample.message, /for call mom/i);
    assert.doesNotMatch(sample.message, /about lease/i);
    const key = sample.plan.intent;
    pathsByIntent.set(key, pathsByIntent.get(key) || new Set());
    pathsByIntent.get(key)?.add(sample.debug?.realizationPath);
  }

  assert.ok((pathsByIntent.get('confirm_result')?.size || 0) >= 2);
  assert.ok((pathsByIntent.get('clarify_missing_detail')?.size || 0) >= 2);
  assert.ok((pathsByIntent.get('request_confirmation')?.size || 0) >= 2);
  assert.ok((pathsByIntent.get('acknowledge_no_change')?.size || 0) >= 2);
});

test('responseEngine: the same rhetorical move has bounded structural variation', () => {
  const store = new MemoryConversationStateStore();
  const turns = [0.01, 0.45, 0.99].map((entropy) => createAssistantTurn({
    event: { type: 'reminder_created', title: 'Call Maya', remindAt: '2026-04-09T18:00:00.000Z' },
    now,
    store,
    record: false,
    realization: { entropy: () => entropy },
  }));

  const paths = new Set(turns.map((turn) => turn.debug?.realizationPath));
  assert.ok(paths.size >= 2);
  for (const turn of turns) assertSafeVisibleCopy(turn.message);
});

test('AssistantPanel: production bubble does not concatenate legacy response fields', () => {
  const source = readFileSync(new URL('../src/components/AssistantPanel.tsx', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /\.\.\.capture\.response\.actions/);
  assert.doesNotMatch(source, /capture\.response\.interpretation[\s\S]{0,120}capture\.response\.nextStep\.message/);
  assert.match(source, /capture\.response\.message/);
});

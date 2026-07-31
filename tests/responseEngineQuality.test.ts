import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhrases, normalizeTimePhrase, phraseKindForTitle } from '../lib/services/responseEngine/phraseNormalization.ts';
import { createAssistantTurn } from '../lib/services/responseEngine/assistantTurn.ts';
import type { ResponsePlan, ResponseStrategy } from '../lib/services/responseEngine/assistantTurn.ts';
import { MemoryConversationStateStore } from '../lib/services/responseEngine/conversationStateStore.ts';
import { realizeResponsePlan } from '../lib/services/responseEngine/realization.ts';
import { validateResponsePlanAndMessage } from '../lib/services/responseEngine/validation.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

const BAD_LANGUAGE = [
  /I have a reminder for call Maya at tomorrow at 6 PM/i,
  /at tomorrow at/i,
  /reminder for call Maya/i,
  /for call mom/i,
  /\bDone, i\b/,
  /about lease/i,
  /\bmaya is waiting\b/,
  /Tracking|Drafted|Executed|You're set|\bcommand\b|\bdisposition\b/i,
  /\bavoidant\b|\binconsistent\b|\blazy\b|\bfault\b|\bfailed\b|\bshame\b|\bguilt\b|\bdisappointed\b/i,
  /\b20\d\d-\d\d-\d\d(?:T|\b)/,
];

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

function basePlan(overrides: Partial<ResponsePlan> = {}): ResponsePlan {
  return {
    intent: 'confirm_result',
    strategy: 'direct_result',
    moves: ['confirm_action'],
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

function pressurePlan(strategy: ResponseStrategy): ResponsePlan {
  const movesByStrategy: Partial<Record<ResponseStrategy, ResponsePlan['moves']>> = {
    easy_choice: ['name_continuity', 'offer_small_step'],
    smaller_step: ['name_continuity', 'offer_small_step'],
    blocker_probe: ['name_continuity', 'probe_blocker'],
    reset_plan: ['name_continuity', 'offer_reset'],
    close_loop: ['name_continuity', 'force_choice'],
  };
  return basePlan({
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
      tone: strategy === 'easy_choice' ? 'light_check' : strategy === 'close_loop' || strategy === 'reset_plan' ? 'firm' : 'direct',
      maxSentences: 2,
      requireQuestion: strategy === 'easy_choice' || strategy === 'blocker_probe',
      forbiddenTerms: [],
    },
  });
}

function assertGoodLanguage(message: string): void {
  assert.notEqual(message.trim(), '');
  for (const pattern of BAD_LANGUAGE) assert.doesNotMatch(message, pattern);
}

test('responseEngineQuality: normalization classifies and smooths display facts', () => {
  assert.equal(phraseKindForTitle('Call Maya'), 'action');
  assert.equal(phraseKindForTitle('Maya is waiting on the invoice'), 'context');
  assert.deepEqual(normalizeTimePhrase('tomorrow at 6 PM'), {
    timeText: 'tomorrow at 6 PM',
    timeWithPreposition: 'tomorrow at 6 PM',
  });
  assert.deepEqual(normalizeTimePhrase('6 PM'), {
    timeText: '6 PM',
    timeWithPreposition: 'at 6 PM',
  });

  const followUp = normalizePhrases({ title: 'Follow up with Daniel about lease', timeText: 'tomorrow at 6 PM' });
  assert.equal(followUp.titleKind, 'action');
  assert.equal(followUp.reminderObject, 'to follow up with Daniel about the lease');
  assert.equal(followUp.reminderNoun, 'follow up with Daniel about the lease reminder');
  assert.equal(followUp.timeWithPreposition, 'tomorrow at 6 PM');

  const context = normalizePhrases({ title: 'Maya is waiting on the invoice' });
  assert.equal(context.titleKind, 'context');
  assert.equal(context.contextClause, 'Maya is waiting on the invoice');
});

test('responseEngineQuality: semantic validator rejects known audit failures', () => {
  const invalidCases: Array<[ResponsePlan, string, RegExp]> = [
    [basePlan(), 'Saved a reminder for send invoice.', /completion resembles creation or tracking/],
    [basePlan(), "Done, I'll remind you about send invoice.", /completion resembles creation or tracking/],
    [basePlan({ facts: { stateChange: 'completed' } }), "I didn't change anything.", /applied state change cannot use no-change language|completion cannot claim no change/],
    [pressurePlan('easy_choice'), 'Call Maya is complete.', /pressure claims a state change/],
    [pressurePlan('blocker_probe'), 'Call Maya has come back twice. Keep it for today or move it?', /blocker_probe pressure realized easy-choice language/],
    [basePlan({ intent: 'acknowledge_no_change', strategy: 'context_boundary', moves: ['acknowledge_without_action'], facts: { stateChange: 'none', noChangeReason: 'informational' } }), 'Saved a note for Maya is waiting on the invoice.', /no-change message implies persistence/],
  ];

  for (const [plan, message, errorPattern] of invalidCases) {
    const result = validateResponsePlanAndMessage(plan, message);
    assert.equal(result.ok, false, `${message} should fail validation`);
    assert.match(result.errors.join(' | '), errorPattern);
  }
});

test('responseEngineQuality: pressure strategies cannot realize incompatible path semantics', () => {
  const invalidPressure: Array<[ResponseStrategy, string]> = [
    ['easy_choice', "Call Maya has come back twice. What's blocking it?"],
    ['blocker_probe', 'Call Maya has come back twice. Keep it for today or move it?'],
    ['smaller_step', "Call Maya has come back twice. What's blocking it?"],
    ['reset_plan', 'Call Maya has come back twice. Keep it for today or move it?'],
    ['close_loop', 'Call Maya has come back twice. Pick a smaller next step or move it.'],
  ];

  for (const [strategy, message] of invalidPressure) {
    const result = validateResponsePlanAndMessage(pressurePlan(strategy), message);
    assert.equal(result.ok, false, `${strategy} accepted incompatible pressure text`);
  }
});

test('responseEngineQuality: adversarial non-pressure sampling rejects malformed grammar', () => {
  const events = [
    { type: 'reminder_created' as const, title: 'Call Maya', remindAt: '2026-04-09T18:00:00.000Z' },
    { type: 'commitment_completed' as const, title: 'Send invoice' },
    { type: 'commitment_moved' as const, title: 'Send invoice', movedTo: '2026-04-09T08:00:00.000Z' },
    { type: 'commitment_updated' as const, title: 'Send invoice', time: '2026-04-10T09:30:00.000Z' },
    { type: 'commitment_cancelled' as const, title: 'Send invoice' },
    { type: 'needs_clarification' as const, missing: 'time' as const, title: 'Call mom' },
    { type: 'needs_clarification' as const, missing: 'action' as const, remindAt: '2026-04-09T18:00:00.000Z' },
    { type: 'needs_clarification' as const, missing: 'person' as const, title: 'Follow up' },
    { type: 'confirmation_needed' as const, title: 'Follow up with Daniel about lease' },
    { type: 'informational_no_change' as const, title: 'Maya is waiting on the invoice' },
  ];
  const store = new MemoryConversationStateStore();

  for (const event of events) {
    const paths = new Set<string | undefined>();
    for (const entropy of [0, 0.12, 0.24, 0.36, 0.48, 0.6, 0.72, 0.84, 0.99]) {
      const turn = createAssistantTurn({
        event,
        now,
        store,
        record: false,
        realization: { entropy: () => entropy },
      });
      assertGoodLanguage(turn.message);
      assert.equal(turn.debug?.validation.ok, true, `${event.type} produced invalid output: ${turn.message}`);
      paths.add(turn.debug?.realizationPath);
    }
    assert.ok(paths.size >= 1, `${event.type} should realize at least one valid path`);
  }
});

test('responseEngineQuality: pressure sampling stays strategy-compatible and structurally varied', () => {
  const strategies: ResponseStrategy[] = ['easy_choice', 'smaller_step', 'blocker_probe', 'reset_plan', 'close_loop'];
  const expectedByStrategy: Record<ResponseStrategy, RegExp> = {
    direct_result: /$a/,
    focused_question: /$a/,
    careful_confirm: /$a/,
    context_boundary: /$a/,
    multi_summary: /$a/,
    easy_choice: /keep it for today|move it\?|do it|handle it today/i,
    smaller_step: /smaller next step|manageable step|make it smaller|next manageable step/i,
    blocker_probe: /blocking|blocker|stuck|what's blocking|what is blocking/i,
    reset_plan: /reset|replan|plan/i,
    close_loop: /finish it|drop it|still open/i,
  };

  for (const strategy of strategies) {
    const paths = new Set<string>();
    const messages = new Set<string>();
    for (const entropy of [0, 0.17, 0.34, 0.51, 0.68, 0.85, 0.99]) {
      const realized = realizeResponsePlan(pressurePlan(strategy), {
        conversationState: emptyConversationState(),
        entropy: () => entropy,
      });
      assertGoodLanguage(realized.message);
      assert.match(realized.message, expectedByStrategy[strategy]);
      assert.equal(validateResponsePlanAndMessage(pressurePlan(strategy), realized.message).ok, true);
      paths.add(realized.path);
      messages.add(realized.message);
    }
    assert.ok(paths.size >= 2, `${strategy} should expose multiple compatible pressure paths`);
    assert.ok(messages.size >= 2, `${strategy} should not collapse to one repeated pressure message`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  captureText,
  clearPendingClarification,
  getPendingClarification,
} from '../lib/services/captureService.ts';
import { MemoryClarificationStore } from '../lib/services/clarificationStore.ts';
import { MemoryBehaviorFeedbackStore } from '../lib/services/behaviorFeedbackService.ts';
import {
  configureCommandService,
  getCommandServiceState,
} from '../lib/services/commandService.ts';
import { createEmptyDomainState } from '../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');
const FORBIDDEN_VISIBLE_COPY = /Tracking|Drafted|Executed|You're set|\bcommand\b|\bdisposition\b|20\d\d-\d\d-\d\d/i;

function assertSafeVisibleCopy(message: string): void {
  assert.notEqual(message.trim(), '');
  assert.doesNotMatch(message, FORBIDDEN_VISIBLE_COPY);
}

function withFreshCommandService(): (() => void) & {
  clarificationStore: MemoryClarificationStore;
  behaviorFeedbackStore: MemoryBehaviorFeedbackStore;
} {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-capture-'));
  const clarificationStore = new MemoryClarificationStore();
  const behaviorFeedbackStore = new MemoryBehaviorFeedbackStore();
  clearPendingClarification();
  configureCommandService({
    initialState: createEmptyDomainState(),
    stateFile: join(dir, 'domain-state.json'),
    schedulerStore: null,
  });
  const cleanup = (() => {
    clearPendingClarification();
    rmSync(dir, { recursive: true, force: true });
  }) as (() => void) & {
    clarificationStore: MemoryClarificationStore;
    behaviorFeedbackStore: MemoryBehaviorFeedbackStore;
  };
  cleanup.clarificationStore = clarificationStore;
  cleanup.behaviorFeedbackStore = behaviorFeedbackStore;
  return cleanup;
}

function llmTaskOutput() {
  return {
    type: 'task',
    action: 'call Maya',
    title: 'Call Maya',
    person: 'Maya',
    dueAt: '2026-04-09T18:00:00.000Z',
    remindAt: '2026-04-09T18:00:00.000Z',
    priority: {
      level: 'normal',
      source: 'default',
      pressureAllowed: false,
      pressureImplied: false,
    },
    flexibility: 'movable',
    confidence: {
      overall: 0.92,
      type: 0.95,
      action: 0.95,
      time: 0.95,
      priority: 0.8,
    },
    missingFields: [],
    ambiguityFlags: [],
    explicitReminderRequest: true,
    explicitPressureRequest: false,
  };
}

test('captureService: auto-confirm flows from input to formatted response', async () => {
  const cleanup = withFreshCommandService();
  try {
    const result = await captureText('Remind me to call Maya tomorrow', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => JSON.stringify(llmTaskOutput()),
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.meta, { engineUsed: 'ollama', disposition: 'auto_confirm' });
    assertSafeVisibleCopy(result.response.message);
    assert.equal(result.response.interpretation, '');
    assert.deepEqual(result.response.actions, []);
    assert.deepEqual(result.response.nextStep, { type: 'none', message: '' });
    assert.equal(Object.values(getCommandServiceState().commitments).length, 1);
  } finally {
    cleanup();
  }
});

test('captureService: extraction fallback still returns a safe response', async () => {
  const cleanup = withFreshCommandService();
  try {
    const result = await captureText('Remind me to call Maya tomorrow', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.meta, { engineUsed: 'rule-based', disposition: 'auto_confirm' });
    assertSafeVisibleCopy(result.response.message);
    assert.deepEqual(result.response.nextStep, { type: 'none', message: '' });
    assert.deepEqual(result.response.actions, []);
  } finally {
    cleanup();
  }
});

test('captureService: multi-commitment input is split and sorted by priority', async () => {
  const cleanup = withFreshCommandService();
  try {
    const result = await captureText(
      'Remind me to pay electricity bill today at 9am urgent, call Maya tomorrow at 6pm, and maybe read a chapter Friday at 8pm',
      {
        now,
        timezone: 'UTC',
        sessionId: 'session-a',
        clarificationStore: cleanup.clarificationStore,
        behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
        llmProvider: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      }
    );

    const commitments = Object.values(getCommandServiceState().commitments);

    assert.equal(result.success, true);
    assert.equal(result.meta.engineUsed, 'rule-based');
    assert.equal(result.meta.disposition, 'multi_commitment');
    assert.equal(
      result.response.message,
      'Saved 3 items. Scheduled pay electricity bill and call Maya. Saved read a chapter for review.'
    );
    assertSafeVisibleCopy(result.response.message);
    assert.equal(result.response.interpretation, '');
    assert.deepEqual(result.response.actions, []);
    assert.deepEqual(result.response.nextStep, { type: 'none', message: '' });
    assert.equal(commitments.length, 3);
    assert.equal(commitments.find((item) => item.title === 'pay electricity bill')?.priority.level, 'high');
    assert.equal(commitments.find((item) => item.title === 'call Maya')?.priority.level, 'normal');
    assert.equal(commitments.find((item) => item.title === 'read a chapter')?.priority.level, 'low');
  } finally {
    cleanup();
  }
});

test('captureService: clarification does not execute hidden draft commands', async () => {
  const cleanup = withFreshCommandService();
  try {
    const result = await captureText('Call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.meta.engineUsed, 'rule-based');
    assert.equal(result.meta.disposition, 'needs_clarification');
    assertSafeVisibleCopy(result.response.message);
    assert.deepEqual(result.response.actions, []);
    assert.equal(result.response.nextStep.type, 'clarify');
    assert.match(result.response.message, /when|what time|date/i);
    assert.equal(Object.values(getCommandServiceState().commitments).length, 0);
    assert.equal(typeof result.meta.pendingClarificationId, 'string');
    assert.equal(result.meta.clarificationScopeId, 'session-a');
  } finally {
    cleanup();
  }
});

test('captureService: next reply resolves pending clarification once', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const second = await captureText('tomorrow at 6pm', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(first.response.nextStep.type, 'clarify');
    assert.equal(getPendingClarification(), null);
    assert.equal(typeof first.meta.pendingClarificationId, 'string');
    assert.deepEqual(second.meta, { engineUsed: 'rule-based', disposition: 'auto_confirm' });
    assertSafeVisibleCopy(second.response.message);
    assert.deepEqual(second.response.nextStep, { type: 'none', message: '' });
    assert.deepEqual(second.response.actions, []);
    assert.equal(Object.values(getCommandServiceState().commitments).length, 1);
    assert.equal(cleanup.behaviorFeedbackStore.get('session-a').clarificationSuccesses, 1);
  } finally {
    cleanup();
  }
});

test('captureService: continuation fills missing date and time without appending blindly', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const second = await captureText('tomorrow at 5', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const commitment = Object.values(getCommandServiceState().commitments)[0];
    assert.equal(second.success, true);
    assert.equal(second.meta.disposition, 'auto_confirm');
    assert.equal(commitment.title, 'call mom');
    assert.equal(commitment.timeSpec.remindAt ? new Date(commitment.timeSpec.remindAt).getHours() : null, 17);
  } finally {
    cleanup();
  }
});

test('captureService: continuation fills missing date without dropping the original clock time', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom at 5pm', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => JSON.stringify({
        ...llmTaskOutput(),
        action: 'call mom',
        title: 'call mom',
        person: null,
        dueAt: null,
        remindAt: null,
        confidence: {
          overall: 0.68,
          type: 0.8,
          action: 0.82,
          time: 0.2,
          priority: 0.8,
        },
        missingFields: ['time'],
        ambiguityFlags: ['vague_time'],
      }),
    });
    const second = await captureText('Friday', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const commitment = Object.values(getCommandServiceState().commitments)[0];
    const remindAt = commitment.timeSpec.remindAt ? new Date(commitment.timeSpec.remindAt) : null;
    assert.equal(second.success, true);
    assert.equal(second.meta.disposition, 'auto_confirm');
    assert.equal(remindAt?.getDay(), 5);
    assert.equal(remindAt?.getHours(), 17);
  } finally {
    cleanup();
  }
});

test('captureService: correction updates date instead of appending a second date', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom tomorrow', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => JSON.stringify({
        ...llmTaskOutput(),
        action: 'call mom',
        title: 'call mom',
        person: null,
        dueAt: null,
        remindAt: null,
        confidence: {
          overall: 0.68,
          type: 0.8,
          action: 0.82,
          time: 0.2,
          priority: 0.8,
        },
        missingFields: ['time'],
      }),
    });
    const second = await captureText('actually Friday', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const commitment = Object.values(getCommandServiceState().commitments)[0];
    assert.equal(second.success, true);
    assert.equal(second.meta.disposition, 'auto_confirm');
    assert.equal(commitment.title, 'call mom');
    assert.equal(commitment.timeSpec.remindAt ? new Date(commitment.timeSpec.remindAt).getDay() : null, 5);
  } finally {
    cleanup();
  }
});

test('captureService: correction safely changes the target person', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom tomorrow', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => JSON.stringify({
        ...llmTaskOutput(),
        action: 'call mom',
        title: 'call mom',
        person: 'mom',
        dueAt: null,
        remindAt: null,
        confidence: {
          overall: 0.68,
          type: 0.8,
          action: 0.82,
          time: 0.2,
          priority: 0.8,
        },
        missingFields: ['time'],
      }),
    });
    const second = await captureText('no, call Sarah', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const commitment = Object.values(getCommandServiceState().commitments)[0];
    assert.equal(second.success, true);
    assert.equal(second.meta.disposition, 'auto_confirm');
    assert.equal(commitment.title, 'call Sarah');
  } finally {
    cleanup();
  }
});

test('captureService: continuation fills a missing person separately', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to follow up tomorrow', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => JSON.stringify({
        ...llmTaskOutput(),
        type: 'follow_up',
        action: 'Follow up',
        title: 'Follow up',
        person: null,
        dueAt: '2026-04-09T18:00:00.000Z',
        remindAt: '2026-04-09T18:00:00.000Z',
        missingFields: ['person'],
        confidence: {
          overall: 0.62,
          type: 0.8,
          action: 0.8,
          time: 0.9,
          priority: 0.8,
        },
      }),
    });
    const second = await captureText('Sarah', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const commitment = Object.values(getCommandServiceState().commitments)[0];
    assert.match(first.response.message, /who/i);
    assert.equal(second.success, true);
    assert.equal(commitment.person, 'Sarah');
  } finally {
    cleanup();
  }
});

test('captureService: continuation fills a missing action verb separately', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me tomorrow', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => JSON.stringify({
        ...llmTaskOutput(),
        action: null,
        title: null,
        person: null,
        dueAt: '2026-04-09T18:00:00.000Z',
        remindAt: '2026-04-09T18:00:00.000Z',
        confidence: {
          overall: 0.68,
          type: 0.8,
          action: 0.2,
          time: 0.9,
          priority: 0.8,
        },
        missingFields: ['action'],
        ambiguityFlags: ['vague_action'],
      }),
    });
    const second = await captureText('call Maya', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    const commitment = Object.values(getCommandServiceState().commitments)[0];
    assert.match(first.response.message, /what/i);
    assert.equal(second.success, true);
    assert.equal(commitment.title, 'call Maya');
  } finally {
    cleanup();
  }
});

test('captureService: ambiguous correction asks a targeted follow-up without corrupting state', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const second = await captureText('Friday or Saturday', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(second.success, false);
    assert.equal(second.response.nextStep.type, 'clarify');
    assert.match(second.response.message, /when|what time|date/i);
    assert.equal(typeof second.meta.pendingClarificationId, 'string');
    assert.equal(Object.values(getCommandServiceState().commitments).length, 0);
    assert.equal(cleanup.behaviorFeedbackStore.get('session-a').clarificationFailures, 1);
  } finally {
    cleanup();
  }
});

test('captureService: continuation is not guessed without a token', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const second = await captureText('tomorrow at 6pm', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(first.response.nextStep.type, 'clarify');
    assert.equal(typeof first.meta.pendingClarificationId, 'string');
    assert.notEqual(second.meta.disposition, 'auto_confirm');
    assert.equal(Object.values(getCommandServiceState().commitments).length, 0);
  } finally {
    cleanup();
  }
});

test('captureService: clarification token is scoped by session', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const stolen = await captureText('tomorrow at 6pm', {
      now,
      timezone: 'UTC',
      sessionId: 'session-b',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const valid = await captureText('tomorrow at 6pm', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(stolen.success, false);
    assert.equal(stolen.meta.disposition, 'no_op');
    assert.equal(valid.success, true);
    assert.equal(valid.meta.disposition, 'auto_confirm');
    assert.equal(Object.values(getCommandServiceState().commitments).length, 1);
  } finally {
    cleanup();
  }
});

test('captureService: expired clarification token is handled safely', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me to call mom', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationTtlMs: 1,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const second = await captureText('tomorrow at 6pm', {
      now: new Date(now.getTime() + 1000),
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(second.success, false);
    assert.equal(second.meta.disposition, 'no_op');
    assertSafeVisibleCopy(second.response.message);
    assert.match(second.response.message, /safe|unchanged|change|detail/i);
    assert.equal(Object.values(getCommandServiceState().commitments).length, 0);
  } finally {
    cleanup();
  }
});

test('captureService: unresolved continuation does not create an infinite clarification loop', async () => {
  const cleanup = withFreshCommandService();
  try {
    const first = await captureText('Remind me', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const second = await captureText('sometime', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      pendingClarificationId: first.meta.pendingClarificationId,
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
      llmProvider: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(first.response.nextStep.type, 'clarify');
    assert.equal(second.success, false);
    assert.equal(second.meta.disposition, 'needs_clarification');
    assert.equal(second.response.nextStep.type, 'clarify');
    assert.equal(typeof second.meta.pendingClarificationId, 'string');
    assert.equal(getPendingClarification(), null);
    assert.equal(Object.values(getCommandServiceState().commitments).length, 0);
  } finally {
    cleanup();
  }
});

test('captureService: empty input returns a safe clarification response', async () => {
  const cleanup = withFreshCommandService();
  try {
    const result = await captureText('   ', {
      now,
      timezone: 'UTC',
      sessionId: 'session-a',
      clarificationStore: cleanup.clarificationStore,
      behaviorFeedbackStore: cleanup.behaviorFeedbackStore,
    });

    assert.equal(result.success, false);
    assert.deepEqual(result.meta, { engineUsed: 'none', disposition: 'needs_clarification' });
    assertSafeVisibleCopy(result.response.message);
    assert.deepEqual(result.response.actions, []);
    assert.equal(result.response.nextStep.type, 'clarify');
    assert.match(result.response.message, /\?/);
  } finally {
    cleanup();
  }
});

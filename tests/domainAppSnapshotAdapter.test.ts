import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureText, clearPendingClarification } from '../lib/services/captureService.ts';
import {
  applyLegacyItemAction,
  getUnifiedAppSnapshot,
  updateCommitmentFromItem,
} from '../lib/services/domainAppSnapshotAdapter.ts';
import {
  configureCommandService,
  getCommandServiceState,
} from '../lib/services/commandService.ts';
import { createEmptyDomainState } from '../src/domain/stateMachine.ts';

const now = new Date('2026-04-08T08:00:00.000Z');

function withFreshCommandService(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-unified-state-'));
  clearPendingClarification();
  configureCommandService({
    initialState: createEmptyDomainState(),
    stateFile: join(dir, 'domain-state.json'),
    schedulerStore: null,
  });
  return () => {
    clearPendingClarification();
    rmSync(dir, { recursive: true, force: true });
  };
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

test('domainAppSnapshotAdapter: capture-created commitment appears in dashboard snapshot', async () => {
  const cleanup = withFreshCommandService();
  try {
    await captureText('Remind me to call Maya tomorrow', {
      now,
      timezone: 'UTC',
      llmProvider: async () => JSON.stringify(llmTaskOutput()),
    });

    const snapshot = await getUnifiedAppSnapshot();

    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.items[0].title, 'Call Maya');
    assert.equal(snapshot.items[0].dueDate, '2026-04-09');
    assert.equal(snapshot.items[0].reminderTime, '18:00');
    assert.equal(snapshot.items[0].state, 'scheduled');
  } finally {
    cleanup();
  }
});

test('domainAppSnapshotAdapter: dashboard actions mutate canonical DomainState', async () => {
  const cleanup = withFreshCommandService();
  try {
    await captureText('Remind me to call Maya tomorrow', {
      now,
      timezone: 'UTC',
      llmProvider: async () => JSON.stringify(llmTaskOutput()),
    });
    const item = (await getUnifiedAppSnapshot()).items[0];

    applyLegacyItemAction(item.id, 'complete');

    assert.equal(getCommandServiceState().commitments[item.id].status, 'completed');
    assert.equal((await getUnifiedAppSnapshot()).items[0].state, 'completed');
  } finally {
    cleanup();
  }
});

test('domainAppSnapshotAdapter: dashboard edits update canonical DomainState', async () => {
  const cleanup = withFreshCommandService();
  try {
    await captureText('Remind me to call Maya tomorrow', {
      now,
      timezone: 'UTC',
      llmProvider: async () => JSON.stringify(llmTaskOutput()),
    });
    const item = (await getUnifiedAppSnapshot()).items[0];

    updateCommitmentFromItem(item.id, {
      title: 'Call Maya about invoice',
      priority: 'must',
      dueDate: '2026-04-10',
      reminderTime: '09:30',
    });

    const commitment = getCommandServiceState().commitments[item.id];
    const snapshotItem = (await getUnifiedAppSnapshot()).items[0];
    assert.equal(commitment.title, 'Call Maya about invoice');
    assert.equal(commitment.priority.level, 'high');
    assert.equal(snapshotItem.title, 'Call Maya about invoice');
    assert.equal(snapshotItem.dueDate, '2026-04-10');
    assert.equal(snapshotItem.reminderTime, '09:30');
  } finally {
    cleanup();
  }
});

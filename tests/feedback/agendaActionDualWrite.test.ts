/**
 * The Sprint 03 dual-write: an agenda action records both the legacy counter
 * and an append-only feedback event.
 *
 * This is the seam between the live system and the new event log, so it is
 * verified centrally rather than by either track: #13 owns the store and #14
 * owns aggregation, but neither owns the call site that feeds them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyAgendaAction } from '../../lib/services/agendaActionService.ts';
import { configureCommandService } from '../../lib/services/commandService.ts';
import { createEmptyDomainState, applyCommand } from '../../src/domain/stateMachine.ts';
import { createInMemoryFeedbackEventStore } from '../../lib/feedback/feedbackEventStore.ts';
import { MemoryBehaviorFeedbackStore } from '../../lib/services/behaviorFeedbackService.ts';
import type { FeedbackEventStore } from '../../src/contracts/v1/feedbackContracts.ts';

const SCOPE = 'dual-write-scope';
const COMMITMENT_ID = 'call-clinic';
const NOW = new Date('2026-08-18T09:00:00.000Z');

/**
 * Seeds one confirmed commitment into a throwaway state file, following the
 * idiom in tests/agendaActionService.test.ts.
 */
function withState(): () => void {
  const dir = mkdtempSync(join(tmpdir(), 'maybesitter-dual-write-'));
  let state = createEmptyDomainState();
  state = applyCommand(state, {
    type: 'CreateDraft',
    now: '2026-08-18T08:00:00.000Z',
    commitment: {
      id: COMMITMENT_ID,
      kind: 'task',
      title: 'Call the clinic',
      timeSpec: { kind: 'unscheduled', dueAt: null, remindAt: null, timezone: 'UTC' },
    },
    draftStatus: 'pending_confirmation',
  }).newState;
  state = applyCommand(state, {
    type: 'ConfirmCommitment',
    commitmentId: COMMITMENT_ID,
    now: '2026-08-18T08:01:00.000Z',
    reminders: [],
  }).newState;

  configureCommandService({
    initialState: state,
    stateFile: join(dir, 'domain-state.json'),
    schedulerStore: null,
  });

  return () => rmSync(dir, { recursive: true, force: true });
}

function optionsFor(eventStore: FeedbackEventStore) {
  return {
    feedbackScopeId: SCOPE,
    feedbackStore: new MemoryBehaviorFeedbackStore(),
    feedbackEventStore: eventStore,
  };
}

test('a completed action writes both the legacy counter and a feedback event', () => {
  const cleanup = withState();
  const events = createInMemoryFeedbackEventStore();
  const options = optionsFor(events);

  const result = applyAgendaAction(COMMITMENT_ID, 'done', NOW, options);
  assert.equal(result.success, true);

  const written = events.list({ scopeId: SCOPE });
  assert.equal(written.length, 1);
  assert.equal(written[0].outcome, 'complete');
  assert.equal(written[0].subjectId, COMMITMENT_ID, 'the event must name the commitment it concerns');
  assert.equal(written[0].actor, 'user');
  assert.equal(written[0].source, 'mobile_action');
  assert.equal(written[0].occurredAt, NOW.toISOString());

  // The legacy counter is still authoritative this sprint and must not have
  // been replaced by the new write.
  assert.equal(options.feedbackStore.get(SCOPE).completedActions, 1);
  cleanup();
});

test('postpone maps to defer and skip maps to ignore', () => {
  for (const [action, outcome] of [['postpone', 'defer'], ['skip', 'ignore']] as const) {
    const cleanup = withState();
    const events = createInMemoryFeedbackEventStore();

    assert.equal(applyAgendaAction(COMMITMENT_ID, action, NOW, optionsFor(events)).success, true);
    const written = events.list({ scopeId: SCOPE });
    assert.equal(written.length, 1, `${action} should emit exactly one event`);
    assert.equal(written[0].outcome, outcome);
    cleanup();
  }
});

test('aware emits no event, because acknowledging is not yet a decision', () => {
  const cleanup = withState();
  const events = createInMemoryFeedbackEventStore();

  assert.equal(applyAgendaAction(COMMITMENT_ID, 'aware', NOW, optionsFor(events)).success, true);
  assert.deepEqual(
    events.list({ scopeId: SCOPE }),
    [],
    'recording an outcome here would log a decision the user never made',
  );
  cleanup();
});

test('replaying the same action does not double count', () => {
  const cleanup = withState();
  const events = createInMemoryFeedbackEventStore();
  const options = optionsFor(events);

  applyAgendaAction(COMMITMENT_ID, 'done', NOW, options);
  // Same commitment, same outcome, same instant: a retry, not a second action.
  applyAgendaAction(COMMITMENT_ID, 'done', NOW, options);

  assert.equal(events.list({ scopeId: SCOPE }).length, 1);
  cleanup();
});

test('a failing event store does not fail the user action or lose the legacy write', () => {
  const exploding: FeedbackEventStore = {
    ...createInMemoryFeedbackEventStore(),
    append() { throw new Error('disk on fire'); },
  };
  const cleanup = withState();
  const options = optionsFor(exploding);

  // The event log is not yet depended on by anything, so a fault in it must not
  // cost the user their action or the counter six modules still read.
  const result = applyAgendaAction(COMMITMENT_ID, 'done', NOW, options);
  assert.equal(result.success, true);
  assert.equal(options.feedbackStore.get(SCOPE).completedActions, 1);
  cleanup();
});

test('an action with no feedback scope writes nothing at all', () => {
  const cleanup = withState();
  const events = createInMemoryFeedbackEventStore();

  assert.equal(
    applyAgendaAction(COMMITMENT_ID, 'done', NOW, { feedbackEventStore: events }).success,
    true,
  );
  assert.deepEqual(events.list({ scopeId: SCOPE }), []);
  cleanup();
});

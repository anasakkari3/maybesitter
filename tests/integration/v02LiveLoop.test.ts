import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEmptyDomainState, type Commitment, type DomainState } from '../../src/domain/stateMachine.ts';
import { getAnalyticsEvents, resetAnalyticsEventsForTests, appendAnalyticsEvent } from '../../lib/analytics/eventStore.ts';
import { getLiveNextStep, recordLiveNextStepDecision } from '../../lib/services/nextStepLiveService.ts';
import { MODULE_FEATURE_FLAG_DEFAULTS, MODULE_KILL_SWITCH_DEFAULTS } from '../../src/contracts/v1/runtimeControls.ts';
import { MemoryIntegrationConnectionStore } from '../../lib/integrations/connections/connectionRegistry.ts';
import { planExternalActionGateway } from '../../lib/actions/externalActionGateway.ts';
import {
  TODOIST_SCOPES,
  TODOIST_SYNC_POLICY,
  normalizeTodoistSyncPage,
  planTodoistMutation,
  planTodoistSync,
} from '../../lib/integrations/todoist/adapter.ts';
import {
  NOTION_SYNC_POLICY,
  normalizeSelectedNotionTask,
  planNotionMutation,
  planNotionSync,
} from '../../lib/integrations/notion/adapter.ts';

const commitment: Commitment = {
  id: 'c1', kind: 'task', title: 'Call Maya', description: null, person: null, status: 'active',
  category: null,
  categorySource: 'inferred',
  priority: { level: 'high', source: 'user_explicit', pressureAllowed: false, pressureLevel: 'none' },
  timeSpec: { kind: 'due_by', dueAt: '2026-08-31T10:00:00.000Z', endAt: null, remindAt: null, allDay: false, timezone: 'UTC' },
  currentAckState: 'aware', postponedUntil: null, createdAt: '2026-08-30T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z', confirmedAt: '2026-08-30T00:00:00.000Z', completedAt: null, droppedAt: null,
};
const state: DomainState = { ...createEmptyDomainState(), commitments: { c1: commitment } };
const controls = (killed = false) => ({ version: 'v1' as const, featureFlags: { ...MODULE_FEATURE_FLAG_DEFAULTS, recommendation: true }, killSwitches: { ...MODULE_KILL_SWITCH_DEFAULTS, recommendation: killed } });
const context = (killed = false) => ({ anonymousUserId: 'pilot-user', consent: 'granted' as const, locale: 'en' as const, now: new Date('2026-08-31T09:00:00.000Z'), controls: controls(killed), emit: appendAnalyticsEvent });

test('V02 live loop: Capture state to recommendation, explanation, decision, and analytics without persistence', async () => {
  for (const decision of ['accept', 'edit', 'defer', 'dismiss', 'done'] as const) {
    await resetAnalyticsEventsForTests();
    const proposal = await getLiveNextStep(state, context());
    assert.equal(proposal.state, 'ready');
    assert.ok(proposal.explanation?.summary);
    const outcome = await recordLiveNextStepDecision(proposal, decision, context(), decision === 'edit' ? 'Call Maya tomorrow' : undefined);
    assert.equal(outcome.persisted, false);
    assert.deepEqual((await getAnalyticsEvents()).map((event) => event.eventName), ['recommendation_shown', `recommendation_${decision === 'accept' ? 'accepted' : decision === 'edit' ? 'edited' : decision === 'defer' ? 'deferred' : decision === 'dismiss' ? 'dismissed' : 'completed'}`]);
  }
});

test('V02 kill switch blocks recommendation and decisions while Capture remains untouched', async () => {
  await resetAnalyticsEventsForTests();
  const proposal = await getLiveNextStep(state, context(true));
  assert.equal(proposal.state, 'insufficient_evidence');
  assert.equal((await getAnalyticsEvents()).length, 0);
  await assert.rejects(recordLiveNextStepDecision({ ...proposal, state: 'ready', availableActions: ['accept'] }, 'accept', context(true)), /kill_switch_active/);
});

test('V02 decisions remain available without analytics consent and emit no event', async () => {
  await resetAnalyticsEventsForTests();
  const withoutConsent = { ...context(), consent: 'essential' as const };
  const proposal = await getLiveNextStep(state, withoutConsent);
  const outcome = await recordLiveNextStepDecision(proposal, 'dismiss', withoutConsent);
  assert.equal(outcome.status, 'recorded_without_penalty');
  assert.equal((await getAnalyticsEvents()).length, 0);
});

test('V02 live loop preserves English, Arabic, and Hebrew locale contracts', async () => {
  for (const locale of ['en', 'ar', 'he'] as const) {
    await resetAnalyticsEventsForTests();
    const proposal = await getLiveNextStep(state, { ...context(), locale });
    assert.equal(proposal.locale, locale);
    assert.equal(proposal.state, 'ready');
    assert.ok(proposal.explanation?.summary);
  }
});

test('V02 route is mounted and the operational owner and rollback controls are explicit', () => {
  const assistant = readFileSync('src/app/assistant/page.tsx', 'utf8');
  const runbook = readFileSync('docs/operations/V02_PILOT_RUNBOOK.md', 'utf8');
  assert.match(assistant, /<NextStepPanel/);
  assert.match(runbook, /Operational owner: \*\*Anas Akkari\*\*/);
  assert.match(runbook, /MAYBESITTER_KILL_SWITCH_RECOMMENDATION=true/);
  assert.match(runbook, /approve rollback/);
});

const PROVIDER_NOW = '2026-09-16T12:00:00.000Z';

async function taskConnection(provider: 'todoist' | 'notion') {
  return new MemoryIntegrationConnectionStore().upsert({
    scopeId: 'scope-provider',
    identity: { provider, providerAccountId: `${provider}-account`, providerSpaceId: provider === 'notion' ? 'workspace-1' : null, displayName: 'Work' },
    state: 'connected',
    capabilities: ['task_read', 'task_write'],
    grantedScopes: provider === 'todoist' ? [TODOIST_SCOPES.read, TODOIST_SCOPES.write] : ['read_content', 'update_content'],
    sync: { cursor: 'cursor-1', checkpointAt: PROVIDER_NOW },
  }, PROVIDER_NOW);
}

const activeTaskToken = {
  accessTokenExpiresAt: '2026-09-16T13:00:00.000Z', refreshTokenExpiresAt: null,
  grantedScopes: ['task'], hasRefreshToken: true, revokedAt: null,
} as const;

function gateway(capability: 'create_external_task' | 'update_external_task', confirmed = true) {
  return planExternalActionGateway({
    actionId: 'action-1', idempotencyKey: 'idem-1', capability, provider: 'task-provider',
    actor: 'model', userConfirmed: confirmed, strongConfirmation: false,
    settingsAllowAutomaticExternalWrites: false,
  });
}

test('Todoist sync uses the canonical connection cursor and dedupes provider repeats', async () => {
  const connection = await taskConnection('todoist');
  assert.equal(planTodoistSync(connection, activeTaskToken, PROVIDER_NOW).cursor, 'cursor-1');
  const task = {
    id: 'todo-1', url: 'https://example.invalid/todo-1', content: 'Call the school',
    description: 'Ask about forms', dueAt: '2026-09-17T09:00:00.000Z', completed: false,
    updatedAt: PROVIDER_NOW,
  };
  const normalized = normalizeTodoistSyncPage({
    syncToken: 'cursor-2', tasks: [task, task], deletedTaskIds: ['gone', 'gone'], fullSync: false,
  }, connection);

  assert.equal(normalized.tasks.length, 1);
  assert.equal(normalized.tasks[0]?.identity.provider, 'todoist');
  assert.deepEqual(normalized.deletedTaskIds, ['gone']);
  assert.equal(normalized.nextCursor, 'cursor-2');
  assert.equal(TODOIST_SYNC_POLICY.ambiguousDedupeAutoMergeAllowed, false);
});

test('Todoist mutations cannot bypass action policy or idempotency', () => {
  const blocked = planTodoistMutation(gateway('create_external_task', false), 'create', null);
  const allowed = planTodoistMutation(gateway('update_external_task'), 'update', 'todo-1');
  const wrong = planTodoistMutation(gateway('create_external_task'), 'update', 'todo-1');

  assert.equal(blocked.execute, false);
  assert.equal(blocked.reason, 'policy_blocked');
  assert.equal(allowed.execute, true);
  assert.equal(allowed.idempotencyKey, 'idem-1');
  assert.equal(wrong.reason, 'wrong_capability');
});

test('Notion sync requires an explicit page or database selection', async () => {
  const connection = await taskConnection('notion');
  const none = planNotionSync(connection, activeTaskToken, { pageIds: [], databaseIds: [] }, PROVIDER_NOW);
  const selected = planNotionSync(connection, activeTaskToken, { pageIds: [], databaseIds: ['db-1'] }, PROVIDER_NOW);

  assert.equal(none.shouldSync, false);
  assert.equal(none.selectedTargetCount, 0);
  assert.equal(selected.shouldSync, true);
  assert.equal(NOTION_SYNC_POLICY.wholeWorkspaceCrawlAllowed, false);
});

test('Notion ignores unselected pages and normalizes selected tasks canonically', async () => {
  const connection = await taskConnection('notion');
  const payload = {
    pageId: 'page-1', databaseId: 'db-1', url: 'https://example.invalid/page-1',
    title: 'Call the school', notes: null, dueAt: '2026-09-17T09:00:00.000Z',
    completed: false, updatedAt: PROVIDER_NOW,
  };
  assert.equal(normalizeSelectedNotionTask(payload, { pageIds: [], databaseIds: [] }, connection), null);
  const normalized = normalizeSelectedNotionTask(payload, { pageIds: [], databaseIds: ['db-1'] }, connection);
  assert.equal(normalized?.identity.provider, 'notion');
  assert.equal(normalized?.identity.externalId, 'page-1');
});

test('Notion writes require both a selected target and an allowed gateway plan', () => {
  const selection = { pageIds: ['page-1'], databaseIds: ['db-1'] };
  assert.equal(planNotionMutation(gateway('update_external_task'), 'update', 'page-1', 'db-1', selection).execute, true);
  assert.equal(planNotionMutation(gateway('update_external_task'), 'update', 'page-2', 'db-2', selection).reason, 'target_not_selected');
  assert.equal(planNotionMutation(gateway('create_external_task', false), 'create', null, 'db-1', selection).reason, 'policy_blocked');
});

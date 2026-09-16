import type { ExternalActionGatewayPlan } from '../../actions/externalActionGateway';
import type { IntegrationConnectionRecord } from '../../../src/contracts/v1/integrationConnectionContracts';
import type { ExternalTaskReference } from '../../../src/contracts/v1/externalTaskContracts';
import { normalizeTodoistTask } from '../tasks/externalTaskNormalizer';
import {
  buildProviderDisconnectRequest,
  planProviderSync,
  type ProviderDisconnectRequest,
  type ProviderOAuthTokenMetadata,
  type ProviderSyncPlan,
} from '../providers/providerRuntime';

export const TODOIST_PROVIDER = 'todoist' as const;
export const TODOIST_SCOPES = Object.freeze({ read: 'data:read', write: 'data:write' } as const);

export interface TodoistTaskPayload {
  readonly id: string;
  readonly url: string | null;
  readonly content: string;
  readonly description: string | null;
  readonly dueAt: string | null;
  readonly completed: boolean;
  readonly updatedAt: string;
}

export interface TodoistSyncPage {
  readonly syncToken: string;
  readonly tasks: readonly TodoistTaskPayload[];
  readonly deletedTaskIds: readonly string[];
  readonly fullSync: boolean;
}

export interface TodoistMutationPlan {
  readonly provider: typeof TODOIST_PROVIDER;
  readonly operation: 'create' | 'update';
  readonly externalId: string | null;
  readonly idempotencyKey: string;
  readonly execute: boolean;
  readonly reason: 'policy_allowed' | 'policy_blocked' | 'wrong_capability';
}

export function planTodoistSync(
  connection: IntegrationConnectionRecord,
  token: ProviderOAuthTokenMetadata | null,
  now: string,
): ProviderSyncPlan {
  return planProviderSync(connection, {
    provider: TODOIST_PROVIDER,
    requiredCapabilities: ['task_read'],
    token,
  }, now);
}

export function normalizeTodoistSyncPage(
  page: TodoistSyncPage,
  connection: IntegrationConnectionRecord,
): { readonly tasks: readonly ExternalTaskReference[]; readonly deletedTaskIds: readonly string[]; readonly nextCursor: string } {
  if (!page.syncToken.trim()) throw new TypeError('Todoist sync token is required');
  const byId = new Map<string, ExternalTaskReference>();
  for (const task of page.tasks) {
    if (!task.id.trim() || !task.content.trim() || !Number.isFinite(Date.parse(task.updatedAt))) {
      throw new TypeError('Malformed Todoist task');
    }
    byId.set(task.id, normalizeTodoistTask({
      scopeId: connection.scopeId,
      connectionId: connection.connectionId,
      providerIdentity: connection.identity,
      externalId: task.id,
      externalUrl: task.url,
      title: task.content,
      notes: task.description,
      dueAt: task.dueAt,
      completed: task.completed,
      updatedAt: task.updatedAt,
      lastSyncedAt: connection.lastSyncedAt,
    }));
  }
  return {
    tasks: Array.from(byId.values()),
    deletedTaskIds: Array.from(new Set(page.deletedTaskIds.filter(Boolean))).sort(),
    nextCursor: page.syncToken,
  };
}

export function planTodoistMutation(
  gateway: ExternalActionGatewayPlan,
  operation: TodoistMutationPlan['operation'],
  externalId: string | null,
): TodoistMutationPlan {
  const expected = operation === 'create' ? 'create_external_task' : 'update_external_task';
  const rightCapability = gateway.capability === expected;
  const execute = rightCapability && gateway.providerExecutionAllowed;
  return {
    provider: TODOIST_PROVIDER,
    operation,
    externalId,
    idempotencyKey: gateway.idempotencyKey ?? gateway.actionId,
    execute,
    reason: !rightCapability ? 'wrong_capability' : execute ? 'policy_allowed' : 'policy_blocked',
  };
}

export function buildTodoistDisconnectRequest(connectionId: string, requestedAt: string): ProviderDisconnectRequest {
  return buildProviderDisconnectRequest(TODOIST_PROVIDER, connectionId, requestedAt);
}

export const TODOIST_SYNC_POLICY = Object.freeze({
  syncTokenOpaqueOutsideAdapter: true,
  providerWritesRequireActionGateway: true,
  ambiguousDedupeAutoMergeAllowed: false,
});

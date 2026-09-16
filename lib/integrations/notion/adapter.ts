import type { ExternalActionGatewayPlan } from '../../actions/externalActionGateway';
import type { IntegrationConnectionRecord } from '../../../src/contracts/v1/integrationConnectionContracts';
import type { ExternalTaskReference } from '../../../src/contracts/v1/externalTaskContracts';
import { normalizeNotionTask } from '../tasks/externalTaskNormalizer';
import {
  buildProviderDisconnectRequest,
  planProviderSync,
  type ProviderDisconnectRequest,
  type ProviderOAuthTokenMetadata,
  type ProviderSyncPlan,
} from '../providers/providerRuntime';

export const NOTION_PROVIDER = 'notion' as const;

export interface NotionSelection {
  readonly pageIds: readonly string[];
  readonly databaseIds: readonly string[];
}

export interface NotionTaskPayload {
  readonly pageId: string;
  readonly databaseId: string | null;
  readonly url: string | null;
  readonly title: string;
  readonly notes: string | null;
  readonly dueAt: string | null;
  readonly completed: boolean | null;
  readonly updatedAt: string;
}

export interface NotionMutationPlan {
  readonly provider: typeof NOTION_PROVIDER;
  readonly operation: 'create' | 'update';
  readonly pageId: string | null;
  readonly idempotencyKey: string;
  readonly execute: boolean;
  readonly reason: 'policy_allowed' | 'policy_blocked' | 'wrong_capability' | 'target_not_selected';
}

export function planNotionSync(
  connection: IntegrationConnectionRecord,
  token: ProviderOAuthTokenMetadata | null,
  selection: NotionSelection,
  now: string,
): ProviderSyncPlan & { readonly selectedTargetCount: number } {
  const plan = planProviderSync(connection, {
    provider: NOTION_PROVIDER,
    requiredCapabilities: ['task_read'],
    token,
  }, now);
  return {
    ...plan,
    shouldSync: plan.shouldSync && selectedTargetCount(selection) > 0,
    reason: plan.shouldSync && selectedTargetCount(selection) === 0 ? 'missing_capability' : plan.reason,
    selectedTargetCount: selectedTargetCount(selection),
  };
}

export function normalizeSelectedNotionTask(
  payload: NotionTaskPayload,
  selection: NotionSelection,
  connection: IntegrationConnectionRecord,
): ExternalTaskReference | null {
  if (!isSelected(payload, selection)) return null;
  if (!payload.pageId.trim() || !payload.title.trim() || !Number.isFinite(Date.parse(payload.updatedAt))) {
    throw new TypeError('Malformed Notion task');
  }
  return normalizeNotionTask({
    scopeId: connection.scopeId,
    connectionId: connection.connectionId,
    providerIdentity: connection.identity,
    externalId: payload.pageId,
    externalUrl: payload.url,
    title: payload.title,
    notes: payload.notes,
    dueAt: payload.dueAt,
    completed: payload.completed,
    updatedAt: payload.updatedAt,
    lastSyncedAt: connection.lastSyncedAt,
  });
}

export function planNotionMutation(
  gateway: ExternalActionGatewayPlan,
  operation: NotionMutationPlan['operation'],
  pageId: string | null,
  databaseId: string | null,
  selection: NotionSelection,
): NotionMutationPlan {
  const expected = operation === 'create' ? 'create_external_task' : 'update_external_task';
  const selected = operation === 'create'
    ? databaseId !== null && selection.databaseIds.includes(databaseId)
    : pageId !== null && (selection.pageIds.includes(pageId) || (databaseId !== null && selection.databaseIds.includes(databaseId)));
  const rightCapability = gateway.capability === expected;
  const execute = selected && rightCapability && gateway.providerExecutionAllowed;
  return {
    provider: NOTION_PROVIDER,
    operation,
    pageId,
    idempotencyKey: gateway.idempotencyKey ?? gateway.actionId,
    execute,
    reason: !selected ? 'target_not_selected' : !rightCapability ? 'wrong_capability' : execute ? 'policy_allowed' : 'policy_blocked',
  };
}

export function buildNotionDisconnectRequest(connectionId: string, requestedAt: string): ProviderDisconnectRequest {
  return buildProviderDisconnectRequest(NOTION_PROVIDER, connectionId, requestedAt);
}

export const NOTION_SYNC_POLICY = Object.freeze({
  wholeWorkspaceCrawlAllowed: false,
  explicitSelectionRequired: true,
  providerWritesRequireActionGateway: true,
  ambiguousDedupeAutoMergeAllowed: false,
});

function selectedTargetCount(selection: NotionSelection): number {
  return new Set([...selection.pageIds, ...selection.databaseIds]).size;
}

function isSelected(payload: NotionTaskPayload, selection: NotionSelection): boolean {
  return selection.pageIds.includes(payload.pageId)
    || (payload.databaseId !== null && selection.databaseIds.includes(payload.databaseId));
}

import type { IntegrationConnectionRecord } from '../../../src/contracts/v1/integrationConnectionContracts';
import type { ConnectedContextSourceProjection } from '../../../src/contracts/v1/userStateProjectionContracts';
import {
  buildProviderDisconnectRequest,
  planProviderSync,
  type ProviderDisconnectRequest,
  type ProviderOAuthTokenMetadata,
  type ProviderSyncPlan,
} from '../providers/providerRuntime';

export const RESCUETIME_PROVIDER = 'rescuetime' as const;
export const RESCUETIME_READ_SCOPE = 'time_data:read' as const;

export interface RescueTimeAggregatePayload {
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly productiveMinutes: number;
  readonly neutralMinutes: number;
  readonly distractingMinutes: number;
  readonly focusSessionMinutes: number;
}

export interface RescueTimeFocusContext {
  readonly provider: typeof RESCUETIME_PROVIDER;
  readonly connectionId: string;
  readonly observedAt: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly productiveMinutes: number;
  readonly neutralMinutes: number;
  readonly distractingMinutes: number;
  readonly focusSessionMinutes: number;
  readonly observedMinutes: number;
  readonly focusRatio: number | null;
  readonly freshness: 'fresh' | 'stale';
  readonly provenance: {
    readonly source: 'rescuetime_aggregate';
    readonly rawActivityPersisted: false;
  };
}

const ALLOWED_AGGREGATE_KEYS = new Set([
  'windowStart',
  'windowEnd',
  'productiveMinutes',
  'neutralMinutes',
  'distractingMinutes',
  'focusSessionMinutes',
]);

const DEFAULT_STALE_AFTER_MS = 36 * 60 * 60 * 1000;

export function parseRescueTimeAggregate(value: unknown): RescueTimeAggregatePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RescueTime aggregate must be an object');
  }
  const record = value as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !ALLOWED_AGGREGATE_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`RescueTime aggregate contains disallowed raw fields: ${unexpected.sort().join(', ')}`);
  }
  for (const key of ['windowStart', 'windowEnd'] as const) {
    if (typeof record[key] !== 'string' || !Number.isFinite(Date.parse(record[key]))) {
      throw new TypeError(`RescueTime ${key} must be an instant`);
    }
  }
  if (Date.parse(record.windowEnd as string) <= Date.parse(record.windowStart as string)) {
    throw new TypeError('RescueTime aggregate window must be positive');
  }
  for (const key of ['productiveMinutes', 'neutralMinutes', 'distractingMinutes', 'focusSessionMinutes'] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key]) || record[key] < 0) {
      throw new TypeError(`RescueTime ${key} must be a non-negative number`);
    }
  }
  return record as unknown as RescueTimeAggregatePayload;
}

export function normalizeRescueTimeAggregate(
  payload: RescueTimeAggregatePayload,
  connectionId: string,
  now: string,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
): RescueTimeFocusContext {
  const parsed = parseRescueTimeAggregate(payload);
  const observedMinutes = parsed.productiveMinutes + parsed.neutralMinutes + parsed.distractingMinutes;
  const focusRatio = observedMinutes === 0 ? null : parsed.productiveMinutes / observedMinutes;
  return {
    provider: RESCUETIME_PROVIDER,
    connectionId,
    observedAt: parsed.windowEnd,
    ...parsed,
    observedMinutes,
    focusRatio,
    freshness: Date.parse(now) - Date.parse(parsed.windowEnd) > staleAfterMs ? 'stale' : 'fresh',
    provenance: { source: 'rescuetime_aggregate', rawActivityPersisted: false },
  };
}

export function planRescueTimeSync(
  connection: IntegrationConnectionRecord,
  token: ProviderOAuthTokenMetadata | null,
  now: string,
): ProviderSyncPlan {
  return planProviderSync(connection, {
    provider: RESCUETIME_PROVIDER,
    requiredCapabilities: ['focus_session_read'],
    token,
  }, now);
}

export function projectRescueTimeContextSource(
  connection: IntegrationConnectionRecord,
  context: RescueTimeFocusContext | null,
): ConnectedContextSourceProjection {
  return {
    provider: RESCUETIME_PROVIDER,
    connectionId: connection.connectionId,
    capabilities: connection.capabilities,
    freshness: context?.freshness ?? 'missing',
    lastSyncedAt: connection.lastSyncedAt,
  };
}

export function buildRescueTimeDisconnectRequest(
  connectionId: string,
  requestedAt: string,
): ProviderDisconnectRequest {
  return buildProviderDisconnectRequest(RESCUETIME_PROVIDER, connectionId, requestedAt);
}

export const RESCUETIME_DATA_POLICY = Object.freeze({
  rawApplicationHistoryAllowed: false,
  rawUrlHistoryAllowed: false,
  aggregateOnly: true,
  medicalOrEmotionalInferenceAllowed: false,
  providerSpecificPlannerFieldsAllowed: false,
});

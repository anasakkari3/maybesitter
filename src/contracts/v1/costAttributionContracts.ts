/**
 * Cost attribution contracts.
 *
 * This extends the existing usage/cost guard vocabulary with feature and
 * provider attribution. It is not a second usage system: storage and caps stay
 * with the usage guard; these records explain where measured cost came from.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';

export const COST_ATTRIBUTION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const COST_ATTRIBUTION_SCHEMA_VERSION = 'cost-attribution-v1' as const;

export type CostProviderKind =
  | 'llm'
  | 'speech'
  | 'health'
  | 'email'
  | 'google'
  | 'microsoft'
  | 'whoop'
  | 'rescuetime'
  | 'todoist'
  | 'notion'
  | 'meeting'
  | 'mcp'
  | 'routing'
  | 'storage_compute'
  | 'revenuecat'
  | 'unknown';

export type CostFeatureKind =
  | 'capture'
  | 'share_intake'
  | 'email_sync'
  | 'calendar_sync'
  | 'health_readiness'
  | 'external_task_sync'
  | 'meeting_intelligence'
  | 'mcp_execution'
  | 'voice'
  | 'routing'
  | 'subscription_entitlement'
  | 'storage'
  | 'planning'
  | 'observability'
  | 'other';

export type CostOperationStatus =
  | 'success'
  | 'failure'
  | 'rate_limited'
  | 'skipped'
  | 'blocked_by_policy';

export interface CostAttributionPeriod {
  readonly startsOn: string;
  readonly endsOn: string;
  readonly timezone: string;
}

export interface CostTokenCounts {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface CostAttributionEvent {
  readonly version: typeof COST_ATTRIBUTION_CONTRACT_VERSION;
  readonly schemaVersion: typeof COST_ATTRIBUTION_SCHEMA_VERSION;
  readonly eventId: string;
  readonly scopeId: string;
  readonly occurredAt: string;
  readonly period: CostAttributionPeriod;
  readonly feature: CostFeatureKind;
  readonly provider: CostProviderKind;
  readonly providerOperation: string;
  readonly status: CostOperationStatus;
  readonly requestCount: number;
  readonly tokenCounts?: CostTokenCounts;
  /**
   * Micros of the billing currency, estimated at call time. Free API calls use
   * zero rather than omitting the field so aggregates can distinguish free from
   * unknown.
   */
  readonly estimatedCostMicros: number;
  readonly currency: 'USD' | 'ILS' | 'UNKNOWN';
  readonly traceId: string | null;
}

export interface CostAttributionAggregate {
  readonly version: typeof COST_ATTRIBUTION_CONTRACT_VERSION;
  readonly schemaVersion: typeof COST_ATTRIBUTION_SCHEMA_VERSION;
  readonly aggregateId: string;
  readonly scopeId: string;
  readonly period: CostAttributionPeriod;
  readonly feature: CostFeatureKind;
  readonly provider: CostProviderKind;
  readonly requestCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostMicros: number;
  readonly currency: 'USD' | 'ILS' | 'MIXED' | 'UNKNOWN';
  readonly updatedAt: string;
}

export const COST_ATTRIBUTION_PRIVACY_POLICY = Object.freeze({
  rawProviderContentAllowed: false,
  rawPromptAllowed: false,
  rawTranscriptAllowed: false,
  rawMailboxBodyAllowed: false,
  rawHealthSamplesAllowed: false,
  tokenTextAllowed: false,
  countsOnly: true,
});

export function isCostFree(event: CostAttributionEvent): boolean {
  return event.estimatedCostMicros === 0;
}

export function aggregateCostEvents(
  aggregateId: string,
  events: readonly CostAttributionEvent[],
  updatedAt: string,
): CostAttributionAggregate {
  if (events.length === 0) {
    throw new Error('cannot aggregate an empty cost event set');
  }
  const [first] = events;
  const currencies = new Set(events.map((event) => event.currency));
  return {
    version: COST_ATTRIBUTION_CONTRACT_VERSION,
    schemaVersion: COST_ATTRIBUTION_SCHEMA_VERSION,
    aggregateId,
    scopeId: first.scopeId,
    period: first.period,
    feature: first.feature,
    provider: first.provider,
    requestCount: events.reduce((sum, event) => sum + event.requestCount, 0),
    inputTokens: events.reduce((sum, event) => sum + (event.tokenCounts?.inputTokens ?? 0), 0),
    outputTokens: events.reduce((sum, event) => sum + (event.tokenCounts?.outputTokens ?? 0), 0),
    estimatedCostMicros: events.reduce((sum, event) => sum + event.estimatedCostMicros, 0),
    currency: currencies.size === 1 ? first.currency : 'MIXED',
    updatedAt,
  };
}

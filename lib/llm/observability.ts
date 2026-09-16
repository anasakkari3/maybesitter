import {
  COST_ATTRIBUTION_CONTRACT_VERSION,
  COST_ATTRIBUTION_SCHEMA_VERSION,
  type CostAttributionEvent,
  type CostFeatureKind,
  type CostOperationStatus,
  type CostProviderKind,
} from '../../src/contracts/v1/costAttributionContracts';

export interface LlmObservabilityInput {
  readonly eventId: string;
  readonly scopeId: string;
  readonly occurredAt: string;
  readonly feature: CostFeatureKind;
  readonly provider: CostProviderKind;
  readonly providerOperation: string;
  readonly status: CostOperationStatus;
  readonly requestCount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly estimatedCostMicros?: number;
  readonly currency?: CostAttributionEvent['currency'];
  readonly traceId?: string | null;
}

export interface LlmObservabilityEnvelope {
  readonly cost: CostAttributionEvent;
  readonly privacy: {
    readonly rawPromptIncluded: false;
    readonly rawCompletionIncluded: false;
    readonly providerPayloadIncluded: false;
  };
}

export function buildLlmObservabilityEnvelope(input: LlmObservabilityInput): LlmObservabilityEnvelope {
  const occurred = new Date(input.occurredAt);
  const day = Number.isNaN(occurred.getTime()) ? input.occurredAt.slice(0, 10) : occurred.toISOString().slice(0, 10);

  return {
    cost: {
      version: COST_ATTRIBUTION_CONTRACT_VERSION,
      schemaVersion: COST_ATTRIBUTION_SCHEMA_VERSION,
      eventId: input.eventId,
      scopeId: input.scopeId,
      occurredAt: input.occurredAt,
      period: {
        startsOn: day,
        endsOn: day,
        timezone: 'UTC',
      },
      feature: input.feature,
      provider: input.provider,
      providerOperation: input.providerOperation,
      status: input.status,
      requestCount: input.requestCount ?? 1,
      tokenCounts: {
        inputTokens: nonNegativeInteger(input.inputTokens),
        outputTokens: nonNegativeInteger(input.outputTokens),
      },
      estimatedCostMicros: nonNegativeInteger(input.estimatedCostMicros),
      currency: input.currency ?? 'UNKNOWN',
      traceId: input.traceId ?? null,
    },
    privacy: {
      rawPromptIncluded: false,
      rawCompletionIncluded: false,
      providerPayloadIncluded: false,
    },
  };
}

function nonNegativeInteger(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

import {
  COST_ATTRIBUTION_CONTRACT_VERSION,
  COST_ATTRIBUTION_SCHEMA_VERSION,
  type CostAttributionEvent,
  type CostAttributionPeriod,
  type CostOperationStatus,
} from '../../../src/contracts/v1/costAttributionContracts';

export const REVENUECAT_ENTITLEMENT_POLICY = Object.freeze({
  projectionOnly: true,
  rawReceiptAllowed: false,
  storeTransactionHistory: false,
  grantsConsent: false,
  mutatesUserState: false,
  nativeSdkRequiredAtThisBoundary: false,
});

export type RevenueCatVerification = 'verified' | 'unverified';
export type EntitlementStatus = 'active' | 'grace_period' | 'inactive' | 'expired' | 'unverified';

export interface RevenueCatEntitlementInput {
  readonly entitlementId: string;
  readonly isActive: boolean;
  readonly expiresAt: string | null;
  readonly willRenew: boolean;
  readonly billingIssueDetectedAt: string | null;
  readonly verification: RevenueCatVerification;
}

export interface NormalizedEntitlement {
  readonly entitlementId: string;
  readonly status: EntitlementStatus;
  readonly expiresAt: string | null;
  readonly willRenew: boolean;
}

export interface EntitlementProjection {
  readonly provider: 'revenuecat';
  readonly scopeId: string;
  readonly fetchedAt: string;
  readonly entitlements: readonly NormalizedEntitlement[];
}

export type EntitlementDecisionReason =
  | 'free_feature'
  | 'entitlement_active'
  | 'entitlement_grace_period'
  | 'projection_missing'
  | 'projection_stale'
  | 'entitlement_missing_or_inactive';

export interface EntitlementDecision {
  readonly allowed: boolean;
  readonly reason: EntitlementDecisionReason;
  readonly entitlementId: string | null;
}

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function statusFor(input: RevenueCatEntitlementInput, nowMs: number): EntitlementStatus {
  if (input.verification !== 'verified') return 'unverified';
  const expiresAt = instant(input.expiresAt);
  if (expiresAt !== null && expiresAt <= nowMs) return 'expired';
  if (!input.isActive) return 'inactive';
  if (input.billingIssueDetectedAt) return 'grace_period';
  return 'active';
}

export function projectRevenueCatEntitlements(input: {
  readonly scopeId: string;
  readonly fetchedAt: string;
  readonly now: string;
  readonly entitlements: readonly RevenueCatEntitlementInput[];
}): EntitlementProjection {
  const nowMs = instant(input.now);
  if (nowMs === null || instant(input.fetchedAt) === null) {
    throw new Error('entitlement projection requires valid timestamps');
  }
  const entitlements = input.entitlements
    .map((entitlement): NormalizedEntitlement => ({
      entitlementId: entitlement.entitlementId,
      status: statusFor(entitlement, nowMs),
      expiresAt: entitlement.expiresAt,
      willRenew: entitlement.willRenew,
    }))
    .sort((left, right) => left.entitlementId.localeCompare(right.entitlementId));
  return Object.freeze({
    provider: 'revenuecat',
    scopeId: input.scopeId,
    fetchedAt: input.fetchedAt,
    entitlements: Object.freeze(entitlements.map((entitlement) => Object.freeze(entitlement))),
  });
}

export function decideFeatureEntitlement(input: {
  readonly projection: EntitlementProjection | null;
  readonly requiredEntitlementIds: readonly string[];
  readonly now: string;
  readonly maxAgeMs: number;
}): EntitlementDecision {
  if (input.requiredEntitlementIds.length === 0) {
    return { allowed: true, reason: 'free_feature', entitlementId: null };
  }
  if (!input.projection) {
    return { allowed: false, reason: 'projection_missing', entitlementId: null };
  }
  const nowMs = instant(input.now);
  const fetchedAt = instant(input.projection.fetchedAt);
  if (
    nowMs === null
    || fetchedAt === null
    || !Number.isFinite(input.maxAgeMs)
    || input.maxAgeMs < 0
    || fetchedAt > nowMs
    || nowMs - fetchedAt > input.maxAgeMs
  ) {
    return { allowed: false, reason: 'projection_stale', entitlementId: null };
  }

  for (const entitlementId of input.requiredEntitlementIds) {
    const entitlement = input.projection.entitlements.find((entry) => entry.entitlementId === entitlementId);
    if (entitlement?.status === 'active') {
      return { allowed: true, reason: 'entitlement_active', entitlementId };
    }
    if (entitlement?.status === 'grace_period') {
      return { allowed: true, reason: 'entitlement_grace_period', entitlementId };
    }
  }
  return { allowed: false, reason: 'entitlement_missing_or_inactive', entitlementId: null };
}

export function entitlementCheckCostEvent(input: {
  readonly eventId: string;
  readonly scopeId: string;
  readonly occurredAt: string;
  readonly period: CostAttributionPeriod;
  readonly status: CostOperationStatus;
  readonly traceId: string | null;
}): CostAttributionEvent {
  return {
    version: COST_ATTRIBUTION_CONTRACT_VERSION,
    schemaVersion: COST_ATTRIBUTION_SCHEMA_VERSION,
    eventId: input.eventId,
    scopeId: input.scopeId,
    occurredAt: input.occurredAt,
    period: input.period,
    feature: 'subscription_entitlement',
    provider: 'revenuecat',
    providerOperation: 'entitlement_projection',
    status: input.status,
    requestCount: 1,
    estimatedCostMicros: 0,
    currency: 'USD',
    traceId: input.traceId,
  };
}

/**
 * The pack's entitlement gate (#528, slice 1).
 *
 * One function, and it is a wrapper around the existing RevenueCat projection
 * decision (`decideFeatureEntitlement`) rather than a pack-specific billing
 * check — "a pack may not invent its own" applies to entitlement logic the
 * same as to OAuth stores and schedulers. A pack with no `entitlementKey` is a
 * free feature; one with a key is allowed exactly while the projection says
 * the entitlement is active or in grace, and the projection's own staleness
 * rules answer every other case.
 *
 * What this does NOT do is the rollout mechanism: enabling and disabling packs
 * against this decision (stopping watchers, removing UI, preserving data) is
 * the follow-up slice. This is the pure judgement that mechanism will call.
 */

import {
  decideFeatureEntitlement,
  type EntitlementDecision,
  type EntitlementProjection,
} from '../integrations/revenuecat/entitlements';
import type { VerticalPackDefinition } from '../../src/contracts/v1/verticalPackContracts';

/** The default freshness bound, matching the projection's own conventions. */
export const PACK_ENTITLEMENT_MAX_AGE_MS = 5 * 60_000;

export function decidePackEntitlement(
  pack: Pick<VerticalPackDefinition, 'entitlementKey'>,
  projection: EntitlementProjection | null,
  now: string,
  maxAgeMs: number = PACK_ENTITLEMENT_MAX_AGE_MS,
): EntitlementDecision {
  return decideFeatureEntitlement({
    projection,
    requiredEntitlementIds: pack.entitlementKey === null ? [] : [pack.entitlementKey],
    now,
    maxAgeMs,
  });
}

/**
 * User-state projection boundary.
 *
 * A UserStateProjection is composed from already-owned sources so downstream
 * modules can reason about the current context without reaching into provider
 * adapters or persistence. It is a read model boundary only: no method here
 * writes canonical user state or stores a projection.
 */

import { MODULE_CONTRACT_VERSION } from './moduleContracts';
import type { ContextProviderKind, IntegrationCapability } from './integrationConnectionContracts';
import type { ReadinessSnapshot } from './readinessContracts';

export const USER_STATE_PROJECTION_CONTRACT_VERSION = MODULE_CONTRACT_VERSION;
export const USER_STATE_PROJECTION_SCHEMA_VERSION = 'user-state-projection-v1' as const;

export type UserStateProjectionSource =
  | 'readiness'
  | 'availability'
  | 'focus'
  | 'memory'
  | 'deadline'
  | 'plan'
  | 'integration_connection';

export type ProjectionFreshness = 'fresh' | 'stale' | 'missing';

export interface ProjectionSectionMeta {
  readonly source: UserStateProjectionSource;
  readonly freshness: ProjectionFreshness;
  readonly updatedAt: string | null;
  readonly inputDigest: string | null;
}

export interface UserStateInterval {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timezone: string;
}

export interface CurrentAvailabilityProjection {
  readonly meta: ProjectionSectionMeta;
  readonly busy: readonly UserStateInterval[];
  readonly free: readonly UserStateInterval[];
  readonly focus: readonly UserStateInterval[];
}

export interface RelevantMemoryProjection {
  readonly meta: ProjectionSectionMeta;
  readonly memoryIds: readonly string[];
  readonly summaryDigest: string | null;
}

export interface DeadlineProjection {
  readonly deadlineId: string;
  readonly dueAt: string;
  readonly kind: 'commitment' | 'external_task' | 'manual';
  readonly sourceRef: string | null;
}

export type UserPlanStatus = 'none' | 'draft' | 'proposed' | 'accepted' | 'stale' | 'blocked';

export interface PlanStatusProjection {
  readonly meta: ProjectionSectionMeta;
  readonly status: UserPlanStatus;
  readonly planId: string | null;
  readonly updatedAt: string | null;
}

export interface ConnectedContextSourceProjection {
  readonly provider: ContextProviderKind;
  readonly connectionId: string;
  readonly capabilities: readonly IntegrationCapability[];
  readonly freshness: ProjectionFreshness;
  readonly lastSyncedAt: string | null;
}

export interface UserStateProjection {
  readonly version: typeof USER_STATE_PROJECTION_CONTRACT_VERSION;
  readonly schemaVersion: typeof USER_STATE_PROJECTION_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly computedAt: string;
  readonly readiness: ReadinessSnapshot | null;
  readonly current: CurrentAvailabilityProjection;
  readonly relevantMemory: RelevantMemoryProjection;
  readonly deadlines: readonly DeadlineProjection[];
  readonly plan: PlanStatusProjection;
  readonly connectedContextSources: readonly ConnectedContextSourceProjection[];
}

export interface UserStateProjectionInput {
  readonly scopeId: string;
  readonly now: string;
  readonly readiness?: ReadinessSnapshot | null;
  readonly busy?: readonly UserStateInterval[];
  readonly free?: readonly UserStateInterval[];
  readonly focus?: readonly UserStateInterval[];
  readonly relevantMemoryIds?: readonly string[];
  readonly deadlines?: readonly DeadlineProjection[];
  readonly plan?: PlanStatusProjection;
  readonly connectedContextSources?: readonly ConnectedContextSourceProjection[];
}

export const USER_STATE_PROJECTION_POLICY = Object.freeze({
  projectionOnly: true,
  persistenceAllowed: false,
  directProviderCallsAllowed: false,
  writesCanonicalUserState: false,
});

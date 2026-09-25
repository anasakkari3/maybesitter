import { apiRequest } from '../client';
import {
  readinessResponseSchema,
  readinessSavedSchema,
  type ReadinessResponse,
  type ReadinessSaved,
} from '../schemas/readiness';

export function getReadiness(): Promise<ReadinessResponse> {
  return apiRequest('GET', '/api/mobile/readiness', { schema: readinessResponseSchema });
}

export function putSubjectiveEnergy(input: { energy: 1 | 2 | 3 | 4 | 5; observedAt: string }): Promise<ReadinessSaved> {
  return apiRequest('PUT', '/api/mobile/readiness', {
    body: input,
    schema: readinessSavedSchema,
  });
}

/**
 * A normalized native health snapshot (HealthKit today), never raw samples.
 *
 * The route accepts only `healthkit` / `health_connect` source kinds, replaces
 * `scopeId` with the verified uid, and stores a sanitized copy — the native
 * values and `normalizedSignals` are dropped server-side. Same answer shape as
 * the check-in PUT.
 */
export function postNativeReadiness(snapshot: { readonly sourceKinds: readonly string[] }): Promise<ReadinessSaved> {
  return apiRequest('POST', '/api/mobile/readiness', {
    body: { snapshot },
    schema: readinessSavedSchema,
  });
}

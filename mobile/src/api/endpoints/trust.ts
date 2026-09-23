import { apiRequest } from '../client';
import { pilotIncidentResponseSchema, trustResponseSchema, type PilotIncidentInput, type TrustAction, type TrustResponse } from '../schemas/trust';

export function getTrust(): Promise<TrustResponse> {
  return apiRequest('GET', '/api/mobile/pilot/trust', { schema: trustResponseSchema });
}

/**
 * Changes a consent, quiet mode, or revokes/deletes the account's data.
 *
 * The server re-reads revocation state without its 60 s cache for this route,
 * because `revoke` and `delete` arrive on it and "at most a minute stale" is
 * not good enough for a destructive path.
 */
export function updateTrust(action: TrustAction): Promise<TrustResponse> {
  return apiRequest('POST', '/api/mobile/pilot/trust', {
    body: { action },
    schema: trustResponseSchema,
  });
}

/** The pilot support route stores only a category and surface, never raw notes. */
export function reportPilotIncident(input: PilotIncidentInput) {
  return apiRequest('POST', '/api/mobile/pilot/incidents', {
    body: input,
    schema: pilotIncidentResponseSchema,
    expectStatus: 201,
  });
}

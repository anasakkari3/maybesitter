import { apiRequest } from '../client';
import { consentsViewSchema, type ConsentsView } from '../schemas/consents';

/**
 * Reads consent from the server, every time (UC-2.1, #161).
 *
 * Never from device storage. Consent lives in one place, and a device that was
 * offline when somebody revoked on another device has to show the revocation as
 * soon as it asks — a cached "granted" is exactly the case where it would not.
 */
export function getConsents(): Promise<ConsentsView> {
  return apiRequest('GET', '/api/mobile/consents', { schema: consentsViewSchema });
}

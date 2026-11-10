import { apiRequest } from '../client';
import { featureCapabilitiesSchema, type FeatureCapabilities } from '../schemas/features';

type Bound = { asUid?: string; signal?: AbortSignal };
const bound = (options: Bound) => ({
  ...(options.asUid !== undefined ? { asUid: options.asUid } : {}),
  ...(options.signal ? { signal: options.signal } : {}),
});

/** The person's features: core and add-ons, whether each is usable now and why not. */
export function getFeatures(options: Bound = {}): Promise<FeatureCapabilities> {
  return apiRequest('GET', '/api/mobile/capabilities/features', { schema: featureCapabilitiesSchema, ...bound(options) });
}

/**
 * The person's own switch for one add-on. The answer is the whole list again,
 * as the server now decides it. A core feature is refused (400
 * `not_switchable`), an id the server does not know is a 404. Never retried:
 * one write per tap.
 */
export function setFeatureEnabled(id: string, enabled: boolean, options: Bound = {}): Promise<FeatureCapabilities> {
  return apiRequest('PUT', `/api/mobile/capabilities/features/${encodeURIComponent(id)}`, {
    body: { enabled },
    schema: featureCapabilitiesSchema,
    ...bound(options),
  });
}

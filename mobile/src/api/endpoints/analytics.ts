import { apiRequest } from '../client';
import { analyticsAckSchema, type AnalyticsProperties, type ClientReportableEvent } from '../schemas/analytics';

/**
 * Reports one content-free loop event.
 *
 * `recorded: false` in the answer is a success, not a failure: it means the
 * user has not granted analytics consent and nothing was written. Treating it
 * as an error would put a toast on screen for a preference the user set.
 */
export function recordAnalyticsEvent(eventName: ClientReportableEvent, properties: AnalyticsProperties = {}) {
  return apiRequest('POST', '/api/mobile/analytics', {
    body: { eventName, properties },
    schema: analyticsAckSchema,
  });
}

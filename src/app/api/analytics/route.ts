import { analyticsContextFrom } from '../../../../lib/analytics/analyticsContext';
import { appendAnalyticsEvent, getAnalyticsEvents } from '../../../../lib/analytics/eventStore';
import { isClientReportableEvent, recordClientEvent, CLIENT_REPORTABLE_EVENTS } from '../../../../lib/analytics/loopAnalytics';
import { buildProductMetricsReport } from '../../../../lib/analytics/productMetrics';
import type { PrivacySafeAnalyticsEvent } from '../../../contracts/v1/analyticsEventContracts';

export const dynamic = 'force-dynamic';

/** Activation, funnel, and retention report over the events recorded so far. */
export async function GET() {
  return Response.json(buildProductMetricsReport(getAnalyticsEvents(), new Date()));
}

/**
 * Records a surface event reported by a client. Only the events a client can legitimately
 * observe are accepted; the payload is validated against the versioned schema before storage.
 */
export async function POST(request: Request) {
  let body: { eventName?: unknown; properties?: unknown; anonymousUserId?: string; consent?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON request body' }, { status: 400 });
  }

  if (!isClientReportableEvent(body.eventName)) {
    return Response.json({ error: `eventName must be one of: ${CLIENT_REPORTABLE_EVENTS.join(', ')}` }, { status: 400 });
  }
  const analytics = analyticsContextFrom(body, appendAnalyticsEvent);
  if (!analytics) return Response.json({ error: 'anonymousUserId is required' }, { status: 400 });

  try {
    const properties = (body.properties ?? {}) as PrivacySafeAnalyticsEvent['properties'];
    const event = recordClientEvent(analytics, body.eventName, properties);
    return Response.json({ recorded: event !== null, eventId: event?.eventId ?? null });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'event rejected' }, { status: 400 });
  }
}

import { analyticsContextFrom } from '../../../../../lib/analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../../../../lib/analytics/eventStore';
import { recordDataDeleted } from '../../../../../lib/analytics/loopAnalytics';
import {
  clearCommitments,
  getUnifiedAppSnapshot,
} from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as { anonymousUserId?: string; consent?: string };
  clearCommitments();
  // Recorded on essential consent too: appending it also purges this user's analytics history.
  const analytics = analyticsContextFrom(body, appendAnalyticsEvent);
  if (analytics) recordDataDeleted(analytics, 'all_commitments');
  return Response.json(await getUnifiedAppSnapshot());
}

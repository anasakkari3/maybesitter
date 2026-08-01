import { analyticsContextFrom } from '../../../../../lib/analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../../../../lib/analytics/eventStore';
import { changedFieldCount, recordCommitmentEdited } from '../../../../../lib/analytics/loopAnalytics';
import { getCommandServiceState } from '../../../../../lib/services/commandService';
import {
  updateCommitmentFromItem,
  getUnifiedAppSnapshot,
} from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { updates?: Record<string, unknown>; anonymousUserId?: string; consent?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body');
  }
  try {
    const analytics = analyticsContextFrom(body, appendAnalyticsEvent);
    const before = analytics ? getCommandServiceState().commitments[id] : undefined;
    updateCommitmentFromItem(id, (body.updates ?? body) as Record<string, unknown>);
    if (analytics) {
      const after = getCommandServiceState().commitments[id];
      const fields = changedFieldCount(before as unknown as Record<string, unknown> | undefined, after as unknown as Record<string, unknown> | undefined);
      if (fields > 0) recordCommitmentEdited(analytics, id, fields);
    }
    return Response.json(await getUnifiedAppSnapshot());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Could not update commitment');
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { listActivity } from '../../../../../lib/services/activity/activityService';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/activity?cursor=<opaque>&limit=<1..50>
 *
 * What this account actually did, newest first (UC-3.15, #201). The uid comes
 * from the verified token and nothing else scopes it.
 *
 * The list is a projection of the domain event log through an allowlist, so
 * pressure deliveries, classification and analytics can never appear here —
 * see lib/services/activity/activityProjection.
 *
 * `cursor` is opaque and is only ever echoed back from a previous response.
 * A value this server did not write is treated as no cursor: the client sees
 * the first page again, which is a better failure than refusing the screen.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get('limit');
  const page = await listActivity({
    uid: user.uid,
    cursor: searchParams.get('cursor'),
    ...(rawLimit === null || rawLimit.trim() === '' ? {} : { limit: Number(rawLimit) }),
  });
  return Response.json(page);
}

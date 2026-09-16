import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { handleRefreshFeed } from '../../../../../../../../lib/calendar/icsFeedRoutes';

export const dynamic = 'force-dynamic';

/** Refresh one feed now; at most once per five minutes (UC-3.4, #188). */
export async function POST(request: Request, context: { params: Promise<{ feedId: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const { feedId } = await context.params;
  return handleRefreshFeed(request, user.uid, feedId);
}

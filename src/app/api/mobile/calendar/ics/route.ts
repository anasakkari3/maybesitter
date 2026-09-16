import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { handleCreateFeed, handleListFeeds } from '../../../../../../lib/calendar/icsFeedRoutes';

export const dynamic = 'force-dynamic';

/**
 * Subscribe to an external calendar by URL, and list subscriptions (UC-3.4,
 * #188). Everything after authentication is in lib/calendar/icsFeedRoutes.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return handleListFeeds(request, user.uid);
}

export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return handleCreateFeed(request, user.uid);
}

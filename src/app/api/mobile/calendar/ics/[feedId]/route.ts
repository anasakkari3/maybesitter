import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { handleDeleteFeed, handleUpdateFeed } from '../../../../../../../lib/calendar/icsFeedRoutes';

export const dynamic = 'force-dynamic';

/** Rename, toggle auto-accept, or unsubscribe one feed (UC-3.4, #188). */
export async function PATCH(request: Request, context: { params: Promise<{ feedId: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const { feedId } = await context.params;
  return handleUpdateFeed(request, user.uid, feedId);
}

/** Unsubscribing: the URL, the busy blocks and the pending proposals go; accepted commitments stay. */
export async function DELETE(request: Request, context: { params: Promise<{ feedId: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const { feedId } = await context.params;
  return handleDeleteFeed(request, user.uid, feedId);
}

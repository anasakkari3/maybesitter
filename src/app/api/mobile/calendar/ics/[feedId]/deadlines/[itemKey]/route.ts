import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { handleDeadlineDecision } from '../../../../../../../../../lib/calendar/icsFeedRoutes';

export const dynamic = 'force-dynamic';

/** Accept, dismiss, undo, apply a move, or acknowledge one proposed deadline (UC-3.4, #188). */
export async function POST(request: Request, context: { params: Promise<{ feedId: string; itemKey: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  const { feedId, itemKey } = await context.params;
  return handleDeadlineDecision(request, user.uid, feedId, itemKey);
}

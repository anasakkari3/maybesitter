import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { listRescheduleProposals, resolveMissedReschedule } from '../../../../../lib/planning/missedWorkReschedule';

export const dynamic = 'force-dynamic';

/**
 * Missed work's new plan (lane E4): the newest missed piece of work's proposal
 * and the plans that can still be undone. Read-only; nothing changes until
 * `POST /api/mobile/reschedule/{commitmentId}` accepts.
 */
export async function GET(request: Request) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveMissedReschedule()) return Response.json({ success: false, error: 'feature_unavailable' }, { status: 404 });
  const result = await listRescheduleProposals(user.uid);
  return Response.json({ success: true, ...result });
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { respondToOccurrenceUndo } from '../../../../../../../../../lib/services/habits/occurrenceOutcome';

export const dynamic = 'force-dynamic';

/**
 * «تراجع» on a day already answered (QA v3, V3-F23-02).
 *
 * `complete` and `skip` refuse a second, different answer about the same day
 * (409), so a stale phone can never overwrite a decision. This is the explicit
 * way back: the day becomes open again and can then take either answer. A
 * make-up date its skip earned goes with it; one already decided makes this a
 * 409. Pressing it twice is not an error: see `respondToOccurrenceUndo`.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string; occurrenceId: string }> },
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return respondToOccurrenceUndo(user.uid, await context.params);
}

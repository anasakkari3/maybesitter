import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { applyOccurrenceOutcome } from '../../../../../../../../../lib/habits/occurrenceOutcome';

export const dynamic = 'force-dynamic';

/**
 * "Not today" (#520).
 *
 * Skipping is a decision about *this* occurrence and says nothing about the
 * habit: the definition is untouched, so tomorrow's occurrence is unaffected
 * and next week's cadence is unchanged. A user who means "stop for a while"
 * wants `PATCH /api/mobile/habits/{id}` with `status: 'paused'`.
 *
 * Whether a skipped occurrence is made up later is `recoveryPolicy`'s answer,
 * and the domain lane's to act on — this route records the skip and nothing
 * more. That is why it cannot produce `recovered`.
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
  return applyOccurrenceOutcome(user.uid, await context.params, 'skipped');
}

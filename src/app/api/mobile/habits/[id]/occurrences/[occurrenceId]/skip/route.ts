import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { respondToOccurrenceOutcome } from '../../../../../../../../../lib/services/habits/occurrenceOutcome';

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
 * and `recoverSkippedOccurrence` gives it: a skip under `recover_within_period`
 * may come back with a `recovery.replacement` — another date this week, inside
 * the habit's own `maximumOccurrences` — and under `skip` it comes back with
 * the reason there is none. This route still cannot produce `recovered`
 * itself; that state is what the *skipped* row becomes once the domain has
 * minted a replacement for it.
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
  return respondToOccurrenceOutcome(user.uid, await context.params, 'skipped');
}

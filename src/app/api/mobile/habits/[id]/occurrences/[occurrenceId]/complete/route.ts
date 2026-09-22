import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../../lib/auth/mobileAuth';
import { respondToOccurrenceOutcome } from '../../../../../../../../../lib/services/habits/occurrenceOutcome';

export const dynamic = 'force-dynamic';

/**
 * "I did it" (#520).
 *
 * A completed occurrence is no longer offered to the planner, which is the
 * adapter's `isOpenOccurrence` filter and not a second rule here — the hour it
 * was holding goes back to the day on the next build.
 *
 * Pressing this twice is not an error: see `respondToOccurrenceOutcome`.
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
  return respondToOccurrenceOutcome(user.uid, await context.params, 'completed');
}

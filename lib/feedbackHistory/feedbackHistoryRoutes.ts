/**
 * Shared plumbing for the two feedback-transparency routes: which scope a
 * request speaks for, and what to say when nothing is wired behind them.
 *
 * ── The defect this closed (UC-1.0e, #144) ───────────────────────
 *
 * `resolveFeedbackScope` used to call the optional pilot guard, which
 * returned `null` for an unauthenticated request whenever no pilot
 * environment was configured. `feedbackScopeIdFor(undefined)` then collapsed
 * to `scopeBehaviorFeedback({})`, the literal default scope `'local'` — one
 * shared bucket that *any* anonymous caller could read the history of and
 * revoke entries in. Both routes were reachable that way.
 *
 * There is no undefined case now. The scope is the uid out of a verified
 * Firebase ID token, and a request without one never reaches the port.
 */

import { requireMobileUser } from '../auth/mobileAuth';
import { scopeBehaviorFeedback } from '../services/behaviorFeedbackService';
import { getFeedbackHistoryPort, type FeedbackHistoryPort } from './feedbackHistoryPort';

/** The scope a user may read and correct: their own, always. */
export function feedbackScopeIdFor(uid: string): string {
  return scopeBehaviorFeedback({ userId: uid });
}

export async function resolveFeedbackScope(request: Request): Promise<string> {
  const { uid } = await requireMobileUser(request);
  return feedbackScopeIdFor(uid);
}

/**
 * Answered while the store is not wired in. An empty 200 would be worse than
 * an error: the user would read "we learned nothing about you" off a screen
 * that simply is not connected.
 */
export function feedbackHistoryUnavailableResponse(): Response {
  return Response.json(
    {
      success: false,
      error: 'feedback history is not available in this build',
      reason: 'feedback_history_unavailable',
    },
    { status: 503 },
  );
}

export function requireFeedbackHistoryPort(): FeedbackHistoryPort | null {
  return getFeedbackHistoryPort();
}

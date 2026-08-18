/**
 * Shared plumbing for the two feedback-transparency routes: which scope a
 * request speaks for, and what to say when nothing is wired behind them.
 */

import { optionalMobilePilotAuth } from '../services/mobile/auth';
import { scopeBehaviorFeedback } from '../services/behaviorFeedbackService';
import { getFeedbackHistoryPort, type FeedbackHistoryPort } from './feedbackHistoryPort';

/**
 * The scope a request may read and correct.
 *
 * In pilot mode this is the authenticated participant, so one participant can
 * never address another's events. Outside pilot mode there is no participant
 * and this collapses to the same default scope the legacy counters have always
 * used, which keeps single-user local development working without inventing a
 * second notion of "whose feedback this is".
 */
export function feedbackScopeIdFor(participantId: string | undefined): string {
  return scopeBehaviorFeedback({ userId: participantId });
}

export function resolveFeedbackScope(request: Request): string {
  const auth = optionalMobilePilotAuth(request);
  return feedbackScopeIdFor(auth?.participantId);
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

import { installDefaultFeedbackHistoryPort } from '../../../../../../lib/feedbackHistory/bootstrap';
import { mobileAuthErrorResponse } from '../../../../../../lib/services/mobile/auth';
import {
  feedbackHistoryUnavailableResponse,
  requireFeedbackHistoryPort,
  resolveFeedbackScope,
} from '../../../../../../lib/feedbackHistory/feedbackHistoryRoutes';
import {
  buildHistoryResponse,
  resolveHistoryLimit,
} from '../../../../../../lib/feedbackHistory/feedbackHistoryView';

export const dynamic = 'force-dynamic';

// Joins this route to the real event store; see lib/feedbackHistory/bootstrap.
installDefaultFeedbackHistoryPort();

/**
 * GET /api/mobile/feedback/history
 *
 * Everything this scope's behaviour log holds, newest first, revoked entries
 * included. Revoked rows stay in the response on purpose: they are the visible
 * proof that a correction was applied, and a history that quietly dropped them
 * would ask the user to take our word for it.
 */
export async function GET(request: Request) {
  let scopeId: string;
  try {
    scopeId = resolveFeedbackScope(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const port = requireFeedbackHistoryPort();
  if (!port) return feedbackHistoryUnavailableResponse();

  const limit = resolveHistoryLimit(new URL(request.url).searchParams.get('limit'));
  return Response.json(buildHistoryResponse(port, scopeId, limit));
}

import { installDefaultFeedbackHistoryPort } from '../../../../../../lib/feedbackHistory/bootstrap';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { listRecentNextStepDecisions } from '../../../../../../lib/services/mobile/nextStepDecisionLog';
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
  let uid: string;
  try {
    scopeId = await resolveFeedbackScope(request);
    uid = (await requireMobileUser(request)).uid;
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const port = requireFeedbackHistoryPort();
  if (!port) return feedbackHistoryUnavailableResponse();

  const limit = resolveHistoryLimit(new URL(request.url).searchParams.get('limit'));

  /*
   * The user's own next-step answers (UC-2.9, #170), read from their own
   * ledger and listed beside the behaviour log.
   *
   * A failure here does not fail the response. The behaviour history is the
   * thing this route exists for, and losing all of it because a second store
   * was slow would be the wrong trade — the decisions are simply absent, which
   * the client renders as an empty section rather than as an error.
   */
  let nextStepDecisions: Awaited<ReturnType<typeof listRecentNextStepDecisions>> = [];
  try {
    nextStepDecisions = await listRecentNextStepDecisions(uid, new Date());
  } catch {
    nextStepDecisions = [];
  }

  return Response.json(await buildHistoryResponse(
    port,
    scopeId,
    limit,
    nextStepDecisions.map((record) => ({
      proposalId: record.proposalId,
      commitmentId: record.commitmentId,
      decision: record.decision,
      at: record.at,
      deferUntil: record.deferUntil,
    })),
  ));
}

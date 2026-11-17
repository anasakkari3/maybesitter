import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../../lib/account/accountLiveness';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';
import {
  decideWatcherProposal,
  parseWatcherProposalDecision,
  parseWatcherProposalId,
  presentWatcherProposal,
  WatcherProposalRequestError,
} from '../../../../../../../lib/services/mobile/watcherProposalService';

export const dynamic = 'force-dynamic';

/**
 * Answer one «اقترح التزام» proposal (QA CA6.1): `{ decision: 'accept', title }`
 * makes one confirmed commitment with the person's title; `{ decision:
 * 'dismiss' }` saves nothing. Decided once — a repeat answers with the
 * decision already recorded. Another account's proposal is not found.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }
  const { id } = await context.params;
  try {
    const proposalId = parseWatcherProposalId(id);
    const decision = parseWatcherProposalDecision(body);
    const proposal = await decideWatcherProposal(user.uid, proposalId, decision, new Date().toISOString());
    if (!proposal) return mobileError('no such proposal', 404);
    return Response.json({ success: true, proposal: presentWatcherProposal(proposal) });
  } catch (error) {
    if (error instanceof WatcherProposalRequestError) {
      return Response.json({ success: false, reason: error.reason }, { status: 400 });
    }
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    console.error('[watchers] deciding a proposal failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not decide the proposal', 500);
  }
}

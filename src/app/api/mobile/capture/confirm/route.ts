import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { CaptureConfirmRefusedError, confirmMobileCapture } from '../../../../../../lib/services/mobile/mobileCaptureService';
import { ProposalChangedError } from '../../../../../../lib/services/captureBoundary';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  try {
    // A `scopeId` in the body is not read: the scope is the authenticated uid.
    const result = await confirmMobileCapture(body, { participantId: user.uid });
    // A confirm that persisted nothing answered 200 before (#252), which no
    // client retry could detect. The status now says it failed — 404 when the
    // proposal is gone, 400 when the request itself is refused — while the
    // body is unchanged, because `failed[]` tells the client which item was
    // rejected and why, and a bare error code would throw that away.
    if (result.success === false) {
      if (result.failureCode && ['too_many_writes', 'habit_invalid', 'goal_invalid', 'seed_invalid'].includes(result.failureCode)) {
        const { success, error, failureCode, replayed, persisted, failed } = result;
        return Response.json({ success, error, failureCode, replayed, persisted, failed }, { status: 400 });
      }
      return Response.json(result, { status: result.failureCode === 'proposal_not_found' ? 404 : 400 });
    }
    return Response.json(result);
  } catch (error) {
    if (error instanceof CaptureConfirmRefusedError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 409 });
    }
    if (error instanceof ProposalChangedError || (error instanceof Error && error.name === 'ProposalChangedError')) {
      const changed = error as ProposalChangedError;
      const v8 = changed.proposal.entry !== undefined || changed.proposal.habits !== undefined || changed.proposal.goals !== undefined;
      return Response.json({ ...(v8 ? { success: false, error: 'proposal_changed' } : {}), reason: 'proposal_changed', proposal: changed.proposal, state: changed.state, ...(changed.confirmation ? { confirmation: changed.confirmation } : {}) }, { status: 409 });
    }
    return mobileError(error instanceof Error ? error.message : 'Confirmation failed');
  }
}

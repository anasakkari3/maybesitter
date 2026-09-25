import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { ClarifyError } from '../../../../../../lib/services/captureBoundary';
import { clarifyMobileCapture } from '../../../../../../lib/services/mobile/mobileCaptureService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Answers the one clarification on one item (UC-2.5, #165).
 *
 * The scope is the authenticated uid; a `scopeId` in the body is not read.
 * Answering a question applies a change to a commitment, so the same rule the
 * confirm follows applies here — a caller must not be able to answer on
 * somebody else's proposal.
 *
 * The response is the updated proposal, not a bare acknowledgement: the item's
 * time, title and `needsClarification` may all have changed, and the review
 * screen has to show what it will actually confirm.
 */
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
    const proposal = await clarifyMobileCapture(body, { participantId: user.uid });
    return Response.json(proposal);
  } catch (error) {
    if (error instanceof ClarifyError) {
      // A missing proposal is 404; everything else is the request being wrong
      // about a proposal that exists. `reason` names which, so the app can tell
      // "ask again" from "open the edit sheet".
      return Response.json(
        { success: false, error: error.message, reason: error.failure },
        { status: error.failure === 'proposal_not_found' ? 404 : 400 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'Clarification failed');
  }
}

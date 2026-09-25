import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { confirmMobileCapture } from '../../../../../../lib/services/mobile/mobileCaptureService';
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
      return Response.json(result, { status: result.failureCode === 'proposal_not_found' ? 404 : 400 });
    }
    return Response.json(result);
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'Confirmation failed');
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { confirmMobileCapture } from '../../../../../../lib/services/mobile/mobileCaptureService';
import { mobileError } from '../../../../../../lib/services/mobile/response';

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
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    // A `scopeId` in the body is not read: the scope is the authenticated uid.
    return Response.json(await confirmMobileCapture(body, { participantId: user.uid }));
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'Confirmation failed');
  }
}

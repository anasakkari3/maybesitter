import { mobileAuthErrorResponse, optionalMobilePilotAuth } from '../../../../../lib/services/mobile/auth';
import { proposeMobileCapture } from '../../../../../lib/services/mobile/mobileCaptureService';
import { mobileError } from '../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let auth;
  try {
    auth = optionalMobilePilotAuth(request);
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
    const proposal = await proposeMobileCapture(body, auth ?? {});
    if (proposal.status === 'rejected') {
      return mobileError('Capture rejected');
    }
    return Response.json(proposal);
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'Capture failed');
  }
}

import { mobileAuthErrorResponse, optionalMobilePilotAuth } from '../../../../../../../lib/services/mobile/auth';
import {
  completeCommitment,
  dropCommitment,
  postponeCommitment,
} from '../../../../../../../lib/services/mobile/commitmentService';
import { commitmentToMobileDto, mobileError } from '../../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let auth;
  try {
    auth = optionalMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  let body: { action?: unknown; postponedUntil?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    const commitment =
      body.action === 'complete'
        ? await completeCommitment(id, new Date(), auth ?? {})
        : body.action === 'postpone'
          ? await postponeCommitment(id, body.postponedUntil, new Date(), auth ?? {})
          : body.action === 'cancel'
            ? await dropCommitment(id, new Date(), auth ?? {})
            : null;
    if (!commitment) return mobileError(`Unknown commitment action: ${String(body.action)}`);
    return Response.json({
      success: true,
      id,
      commitment: commitmentToMobileDto(commitment),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Action failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

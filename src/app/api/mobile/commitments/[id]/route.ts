import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import {
  dropCommitment,
  getCommitment,
  patchCommitment,
} from '../../../../../../lib/services/mobile/commitmentService';
import { commitmentToMobileDto, mobileError } from '../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  // Another user's commitment is simply not in this user's tree, so it reads
  // as 404 rather than 403 — and a probe learns nothing from the difference.
  const commitment = await getCommitment(id, { participantId: user.uid });
  if (!commitment) return mobileError('Commitment not found', 404);
  return Response.json(commitmentToMobileDto(commitment));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    return Response.json(commitmentToMobileDto(await patchCommitment(id, body, new Date(), { participantId: user.uid })));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Patch failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  try {
    const commitment = await dropCommitment(id, new Date(), { participantId: user.uid });
    return Response.json({
      success: true,
      id,
      deleted: false,
      softDeleted: true,
      status: commitment.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Delete failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

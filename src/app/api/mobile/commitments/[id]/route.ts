import {
  dropCommitment,
  getCommitment,
  patchCommitment,
} from '../../../../../../lib/services/mobile/commitmentService';
import { commitmentToMobileDto, mobileError } from '../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const commitment = getCommitment(id);
  if (!commitment) return mobileError('Commitment not found', 404);
  return Response.json(commitmentToMobileDto(commitment));
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  try {
    return Response.json(commitmentToMobileDto(patchCommitment(id, body)));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Patch failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const commitment = dropCommitment(id);
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

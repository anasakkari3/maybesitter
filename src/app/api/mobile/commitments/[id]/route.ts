import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import {
  collisionsForExistingCommitment,
  dropCommitment,
  getCommitment,
  InvalidTransitionError,
  patchCommitment,
} from '../../../../../../lib/services/mobile/commitmentService';
import { StaleCommitmentError } from '../../../../../../lib/services/mobile/participantState';
import {
  etagFor,
  ifMatchFrom,
  invalidTransitionResponse,
  staleCommitmentResponse,
} from '../../../../../../lib/services/mobile/preconditions';
import { commitmentToMobileDto, mobileError } from '../../../../../../lib/services/mobile/response';
import { getDeviceCalendarLink } from '../../../../../../lib/services/calendar/deviceCalendarLinks';

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
  // The validator the client sends back as `If-Match` when it edits (#148).
  const link = await getDeviceCalendarLink(user.uid, id);
  return Response.json(commitmentToMobileDto(commitment, undefined, link), {
    headers: { ETag: etagFor(commitment) },
  });
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
    const updated = await patchCommitment(id, body, new Date(), {
      participantId: user.uid,
      expectedValidator: ifMatchFrom(request),
    });
    // Read after the write: an edit that moved the time is exactly when the
    // client has to know which event to move with it.
    const link = await getDeviceCalendarLink(user.uid, id);
    // And what the edit now lands on top of: an edit that moves a time onto
    // Saturday's match is warned about the way a capture there is. Additive,
    // so a client that does not read it parses the same DTO as before.
    const collisions = await collisionsForExistingCommitment(id, { participantId: user.uid });
    return Response.json({ ...commitmentToMobileDto(updated, undefined, link), collisions }, {
      headers: { ETag: etagFor(updated) },
    });
  } catch (error) {
    if (error instanceof StaleCommitmentError) return staleCommitmentResponse(error.current);
    if (error instanceof InvalidTransitionError) return invalidTransitionResponse();
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
    const commitment = await dropCommitment(id, new Date(), {
      participantId: user.uid,
      expectedValidator: ifMatchFrom(request),
    });
    return Response.json({
      success: true,
      id,
      deleted: false,
      softDeleted: true,
      status: commitment.status,
    }, { headers: { ETag: etagFor(commitment) } });
  } catch (error) {
    if (error instanceof StaleCommitmentError) return staleCommitmentResponse(error.current);
    if (error instanceof InvalidTransitionError) return invalidTransitionResponse();
    const message = error instanceof Error ? error.message : 'Delete failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

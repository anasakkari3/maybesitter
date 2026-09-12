import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  completeCommitment,
  dropCommitment,
  InvalidTransitionError,
  postponeCommitment,
} from '../../../../../../../lib/services/mobile/commitmentService';
import { StaleCommitmentError } from '../../../../../../../lib/services/mobile/participantState';
import {
  etagFor,
  ifMatchFrom,
  invalidTransitionResponse,
  staleCommitmentResponse,
} from '../../../../../../../lib/services/mobile/preconditions';
import { commitmentToMobileDto, mobileError } from '../../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

export async function POST(
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
  let body: { action?: unknown; postponedUntil?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  // Carried into the same transaction that writes, so an action from a device
  // holding a stale copy is refused rather than applied (#148).
  const scope = { participantId: user.uid, expectedValidator: ifMatchFrom(request) };
  try {
    const commitment =
      body.action === 'complete'
        ? await completeCommitment(id, new Date(), scope)
        : body.action === 'postpone'
          ? await postponeCommitment(id, body.postponedUntil, new Date(), scope)
          : body.action === 'cancel'
            ? await dropCommitment(id, new Date(), scope)
            : null;
    if (!commitment) return mobileError(`Unknown commitment action: ${String(body.action)}`);
    return Response.json({
      success: true,
      id,
      commitment: commitmentToMobileDto(commitment),
    }, { headers: { ETag: etagFor(commitment) } });
  } catch (error) {
    if (error instanceof StaleCommitmentError) return staleCommitmentResponse(error.current);
    if (error instanceof InvalidTransitionError) return invalidTransitionResponse();
    const message = error instanceof Error ? error.message : 'Action failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

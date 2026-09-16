import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import {
  applyCommitmentAction,
  InvalidTransitionError,
  type CommitmentActionName,
} from '../../../../../../../lib/services/mobile/commitmentService';
import { ClientActionIdReusedError, StaleCommitmentError } from '../../../../../../../lib/services/mobile/participantState';
import {
  etagFor,
  ifMatchFrom,
  invalidTransitionResponse,
  staleCommitmentResponse,
} from '../../../../../../../lib/services/mobile/preconditions';
import { commitmentToMobileDto, mobileError } from '../../../../../../../lib/services/mobile/response';
import { getDeviceCalendarLink } from '../../../../../../../lib/services/calendar/deviceCalendarLinks';

export const dynamic = 'force-dynamic';

const ACTIONS: readonly CommitmentActionName[] = ['complete', 'postpone', 'cancel', 'aware'];
const CLIENT_ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  let body: { action?: unknown; postponedUntil?: unknown; clientActionId?: unknown };
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  if (!ACTIONS.includes(body.action as CommitmentActionName)) {
    return mobileError(`Unknown commitment action: ${String(body.action)}`);
  }
  // A notification tap replayed by the phone's outbox (#200). Random, from the
  // device; a lower-case UUID so it is also a valid document id.
  if (body.clientActionId !== undefined
    && (typeof body.clientActionId !== 'string' || !CLIENT_ACTION_ID.test(body.clientActionId))) {
    return mobileError('clientActionId must be a lower-case UUID');
  }

  try {
    // The If-Match is carried into the same transaction that writes, so an
    // action from a device holding a stale copy is refused rather than
    // applied (#148).
    const { commitment, replayed } = await applyCommitmentAction(id, body.action as CommitmentActionName, {
      postponedUntil: body.postponedUntil,
      participantId: user.uid,
      expectedValidator: ifMatchFrom(request),
      ...(typeof body.clientActionId === 'string' ? { clientActionId: body.clientActionId } : {}),
    });
    // A postpone moves the event and a cancel removes it, so the link travels
    // with the answer rather than costing the client a second request (#185).
    const link = await getDeviceCalendarLink(user.uid, id);
    return Response.json({
      success: true,
      id,
      commitment: commitmentToMobileDto(commitment, undefined, link),
      ...(replayed ? { replayed: true } : {}),
    }, { headers: { ETag: etagFor(commitment) } });
  } catch (error) {
    if (error instanceof StaleCommitmentError) return staleCommitmentResponse(error.current);
    if (error instanceof InvalidTransitionError) return invalidTransitionResponse();
    if (error instanceof ClientActionIdReusedError) {
      return Response.json({ success: false, reason: 'client_action_id_reused' }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : 'Action failed';
    return mobileError(message, message === 'Commitment not found' ? 404 : 400);
  }
}

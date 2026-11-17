import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../lib/account/accountLiveness';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';
import { ClientActionIdReusedError } from '../../../../../../lib/services/mobile/participantState';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  acceptReschedule,
  dismissReschedule,
  NothingToDismissError,
  RescheduleNotFoundError,
  RescheduleStaleError,
  resolveMissedReschedule,
  undoReschedule,
  UndoUnavailableError,
} from '../../../../../../lib/planning/missedWorkReschedule';

export const dynamic = 'force-dynamic';

const CLIENT_ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * «اقبل» / «مش هلّق» / «رجّعها» on missed work's new plan (lane E4). Owner-only
 * (the commitment is read from the caller's own tree), at most once per
 * `clientActionId`, behind the account fence (#772).
 */
export async function POST(request: Request, { params }: { params: Promise<{ commitmentId: string }> }) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveMissedReschedule()) return Response.json({ success: false, error: 'feature_unavailable' }, { status: 404 });
  const { commitmentId } = await params;
  let body: { action?: unknown; proposalId?: unknown; clientActionId?: unknown };
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mobileError('Invalid JSON request body');
  const { action, proposalId, clientActionId } = body;
  if (action !== 'accept' && action !== 'dismiss' && action !== 'undo') return mobileError('action must be accept, dismiss or undo');
  if (typeof clientActionId !== 'string' || !CLIENT_ACTION_ID.test(clientActionId)) return mobileError('clientActionId must be a lower-case UUID');
  if (action === 'accept' && (typeof proposalId !== 'string' || !PROPOSAL_ID.test(proposalId))) return mobileError('proposalId is required to accept');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(commitmentId)) return mobileError('Commitment not found', 404);

  try {
    const result = action === 'accept'
      ? await acceptReschedule(user.uid, commitmentId, { proposalId: proposalId as string, clientActionId })
      : action === 'dismiss'
        ? await dismissReschedule(user.uid, commitmentId, { clientActionId })
        : await undoReschedule(user.uid, commitmentId, { clientActionId });
    return Response.json({
      success: true,
      state: result.state,
      ...(result.undoUntil ? { undoUntil: result.undoUntil } : {}),
      ...(result.replayed ? { replayed: true } : {}),
    });
  } catch (error) {
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    if (error instanceof RescheduleNotFoundError) return mobileError('Commitment not found', 404);
    if (error instanceof RescheduleStaleError) return Response.json({ success: false, error: 'proposal_stale', proposal: error.fresh }, { status: 409 });
    if (error instanceof UndoUnavailableError) return Response.json({ success: false, error: 'undo_unavailable' }, { status: 409 });
    if (error instanceof NothingToDismissError) return Response.json({ success: false, error: 'nothing_to_dismiss' }, { status: 409 });
    if (error instanceof ClientActionIdReusedError) return Response.json({ success: false, reason: 'client_action_id_reused' }, { status: 409 });
    throw error;
  }
}

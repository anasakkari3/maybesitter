import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { CaptureInputTooLargeError } from '../../../../../../lib/services/captureBoundary/captureBoundaryService';
import { CaptureChatError, CaptureChatProposalChangedError, chatMobileCapture } from '../../../../../../lib/services/captureChat/captureChatService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * The capture chat «احكيها» (owner decision 2026-09-30).
 *
 * `{ conversationId?, message, timezone, referenceTime }` in;
 * `{ conversationId, reply, engine, proposal, turns }` out. `proposal` is the
 * shape `POST /api/mobile/capture` returns, and its `proposalId` is what
 * `/capture/clarify` and `/capture/confirm` take — nothing is saved here.
 *
 * The scope is the authenticated uid; a conversation id another account
 * minted is a 404, the same as one that never existed or has expired.
 *
 *   400 { reason: 'message_required' | 'invalid_conversation_id' }
 *   404 { reason: 'conversation_not_found' }
 *   413 { reason: 'text_too_long', maxCharacters }  — the capture's own limit
 *   413 { reason: 'payload_too_large', maxBytes }     — the request body limit
 */
export async function POST(request: Request) {
  const requestStartedAt = Date.now();
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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mobileError('Invalid JSON request body');

  try {
    return Response.json(await chatMobileCapture(body, { participantId: user.uid, requestStartedAt }));
  } catch (error) {
    if (error instanceof CaptureChatProposalChangedError || (error instanceof Error && error.name === 'CaptureChatProposalChangedError')) {
      const changed = error as CaptureChatProposalChangedError;
      return Response.json({ reason: 'proposal_changed', answer: changed.answer, state: changed.state }, { status: 409 });
    }
    if (error instanceof CaptureChatError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: error.status });
    }
    // The capture route's own 413, so the phone's existing mapping reads it.
    if (error instanceof CaptureInputTooLargeError) {
      return Response.json(
        { success: false, error: error.message, reason: 'text_too_long', maxCharacters: error.maxCharacters },
        { status: 413 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'Chat failed');
  }
}

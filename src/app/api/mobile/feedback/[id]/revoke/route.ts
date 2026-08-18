import { mobileAuthErrorResponse } from '../../../../../../../lib/services/mobile/auth';
import {
  feedbackHistoryUnavailableResponse,
  requireFeedbackHistoryPort,
  resolveFeedbackScope,
} from '../../../../../../../lib/feedbackHistory/feedbackHistoryRoutes';
import { toHistoryRow } from '../../../../../../../lib/feedbackHistory/feedbackHistoryView';
import { FEEDBACK_EVENT_SCHEMA_VERSION } from '../../../../../../../src/contracts/v1/feedbackContracts';

export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/feedback/{id}/revoke
 *
 * The user telling us we misread them. This stamps `revokedAt` on the event so
 * it leaves every future aggregate while staying visible in history; it never
 * appends an `undo`, because an `undo` is a behaviour the user performed and
 * this is a correction of our record of them.
 *
 * It takes no body and asks no second question. The single-step shape is the
 * point: a confirmation step here would only add friction to the one direction
 * the user is trying to move.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let scopeId: string;
  try {
    scopeId = resolveFeedbackScope(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  const eventId = typeof id === 'string' ? id.trim() : '';
  if (!eventId) {
    return Response.json(
      { success: false, error: 'event id is required', reason: 'invalid_event_id' },
      { status: 400 },
    );
  }

  const port = requireFeedbackHistoryPort();
  if (!port) return feedbackHistoryUnavailableResponse();

  const result = port.revokeForScope(scopeId, eventId, new Date().toISOString());
  if (result.outcome === 'not_found') {
    // Same answer whether the event does not exist or belongs to someone else.
    // Event ids are derived from their own fields, so an id is guessable and
    // a 403 here would confirm that someone else's event exists.
    return Response.json(
      { success: false, error: 'feedback event not found', reason: 'event_not_found' },
      { status: 404 },
    );
  }
  if (result.outcome === 'failed') {
    // The event is real and the correction did not land. Saying so is the only
    // honest answer; a 200 here would be the screen's central failure.
    return Response.json(
      { success: false, error: 'the revocation could not be applied', reason: 'revoke_failed' },
      { status: 500 },
    );
  }

  return Response.json({
    version: FEEDBACK_EVENT_SCHEMA_VERSION,
    success: true,
    // True when the correction was already on record. Reported rather than
    // hidden, and the original timestamp is preserved either way.
    alreadyRevoked: result.outcome === 'already_revoked',
    row: toHistoryRow(result.event),
  });
}

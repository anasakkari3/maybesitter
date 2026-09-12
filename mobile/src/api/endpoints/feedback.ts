import { apiRequest } from '../client';
import {
  alphaFeedbackSchema,
  feedbackHistorySchema,
  feedbackRevokeSchema,
  type AlphaFeedbackCategory,
} from '../schemas/feedback';

export function getFeedbackHistory(limit?: number) {
  return apiRequest('GET', '/api/mobile/feedback/history', {
    query: { limit },
    schema: feedbackHistorySchema,
  });
}

/**
 * The user telling us we misread them. One step, no confirmation dialog: a
 * second question here would only add friction to the one direction the user
 * is trying to move. The row stays in history with `revokedAt` set — visible
 * proof the correction was applied.
 */
export function revokeFeedback(eventId: string) {
  return apiRequest('POST', `/api/mobile/feedback/${encodeURIComponent(eventId)}/revoke`, {
    body: {},
    schema: feedbackRevokeSchema,
  });
}

/** 201, and 403 `feature_disabled` when the alpha flag is off on the server. */
export function flagAlphaFeedback(input: {
  proposalId: string;
  category: AlphaFeedbackCategory;
  note?: string;
  commitmentId?: string;
}) {
  return apiRequest('POST', '/api/mobile/alpha/feedback', {
    body: {
      proposalId: input.proposalId,
      category: input.category,
      ...(input.note ? { note: input.note } : {}),
      ...(input.commitmentId ? { commitmentId: input.commitmentId } : {}),
    },
    schema: alphaFeedbackSchema,
    expectStatus: 201,
  });
}

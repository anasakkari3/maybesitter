import { apiRequest } from '../client';
import { captureConfirmationSchema, captureProposalSchema, type CaptureConfirmation, type CaptureProposal } from '../schemas/capture';

/**
 * Capture is two calls on purpose. The first proposes and persists nothing;
 * the second is the user saying yes. There is no client-side shortcut between
 * them, and no retry wrapped around the confirm.
 */

/**
 * Answers the one clarification on one item (UC-2.5, #165).
 *
 * The response is the whole updated proposal, not an acknowledgement: the
 * item's time, title and `needsClarification` may all have changed, and the
 * review screen has to show what it will actually confirm.
 *
 * Never retried. An answer is a decision about somebody's commitment, and a
 * replay of one the user is no longer looking at is the failure #157 forbids
 * for the confirm for the same reason.
 */
export function clarifyCapture(input: {
  proposalId: string;
  itemId: string;
  questionId: string;
  optionId?: string;
  freeText?: string;
  timezone: string;
}): Promise<CaptureProposal> {
  return apiRequest('POST', '/api/mobile/capture/clarify', {
    body: {
      proposalId: input.proposalId,
      itemId: input.itemId,
      questionId: input.questionId,
      timezone: input.timezone,
      referenceTime: new Date().toISOString(),
      ...(input.optionId ? { optionId: input.optionId } : {}),
      ...(input.freeText ? { freeText: input.freeText } : {}),
    },
    schema: captureProposalSchema,
  });
}

export function proposeCapture(input: {
  text: string;
  timezone: string;
  referenceTime?: string;
  signal?: AbortSignal;
}): Promise<CaptureProposal> {
  return apiRequest('POST', '/api/mobile/capture', {
    body: {
      text: input.text,
      timezone: input.timezone,
      referenceTime: input.referenceTime ?? new Date().toISOString(),
    },
    schema: captureProposalSchema,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

/**
 * Confirms the items the user selected.
 *
 * Two things this deliberately does **not** do:
 *
 *  - it does not retry. A confirm that may or may not have landed must not be
 *    replayed without the user present (#157), and the server's idempotency
 *    key is keyed to the proposal, not to a client attempt counter;
 *  - it does not treat a 200 as success on its own. Before #252 a confirm that
 *    persisted nothing still answered 200, and no client could tell. The
 *    server now answers 404 or 400 for that case — which this client surfaces
 *    — and `success` in the body is checked as well, so a regression on either
 *    side is caught rather than swallowed.
 */
export async function confirmCapture(input: {
  proposalId: string;
  itemIds: string[];
  idempotencyKey?: string;
}): Promise<CaptureConfirmation> {
  const result = await apiRequest('POST', '/api/mobile/capture/confirm', {
    body: {
      proposalId: input.proposalId,
      itemIds: input.itemIds,
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
    schema: captureConfirmationSchema,
  });
  return result;
}

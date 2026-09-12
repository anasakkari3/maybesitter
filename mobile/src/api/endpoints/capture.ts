import { apiRequest } from '../client';
import { captureConfirmationSchema, captureProposalSchema, type CaptureConfirmation, type CaptureProposal } from '../schemas/capture';

/**
 * Capture is two calls on purpose. The first proposes and persists nothing;
 * the second is the user saying yes. There is no client-side shortcut between
 * them, and no retry wrapped around the confirm.
 */

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

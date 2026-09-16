/**
 * One outbox item, sent (UC-3.14, #200).
 *
 * The only judgement here is which failures are worth another attempt.
 *
 * - **Retry**: nothing reached a server, the server was down, or the token
 *   could not be refreshed yet. The same `clientActionId` goes again, and the
 *   server replays it if it had in fact applied it.
 * - **Drop**: the server read the request and refused it — the commitment is
 *   gone (404), already finished or dropped (409), or the request is not one it
 *   will ever accept (400, 403). Sending it again cannot change the answer, and
 *   a queue that retries a refusal eight times is a queue that delays every
 *   tap behind it.
 */
import { actOnCommitment } from '../../api/endpoints/commitments';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../api/errors';
import type { OutboxItem, SendOutcome } from './actionOutbox';

export function outcomeOfError(error: unknown): SendOutcome {
  if (error instanceof NotFoundError || error instanceof ConflictError) return 'drop';
  if (error instanceof ValidationError || error instanceof ForbiddenError) return 'drop';
  return 'retry';
}

export async function sendOutboxItem(item: OutboxItem): Promise<SendOutcome> {
  try {
    await actOnCommitment(item.commitmentId, item.action, {
      clientActionId: item.clientActionId,
      ...(item.postponedUntil ? { postponedUntil: item.postponedUntil } : {}),
    });
    return 'sent';
  } catch (error) {
    return outcomeOfError(error);
  }
}

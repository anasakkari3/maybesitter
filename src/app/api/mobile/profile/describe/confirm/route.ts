import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';
import {
  ProposalNotFoundError,
  confirmProfileSuggestions,
  type AcceptedSuggestion,
} from '../../../../../../../lib/services/mobile/profileDescribeService';
import { mobileError } from '../../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

/**
 * Writes the suggestions the user ticked (UC-2.7b, #168).
 *
 * This is the only path by which a self-description becomes something the
 * product remembers. `POST /describe` writes no memory record at all — closing
 * the review screen leaves nothing behind, which is the invariant this pair
 * exists to hold.
 *
 * No AI consent check here: nothing reaches a model on this path, and the
 * suggestions were produced under a consent that was checked when they were
 * made. Re-checking would mean somebody who revoked mid-review loses the
 * choices they had already ticked — a worse outcome than saving what they
 * explicitly asked to save.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const disabled = moduleDisabledResponse('memory');
  if (disabled) return disabled;

  let body: { proposalId?: unknown; accepted?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return mobileError('Invalid JSON request body');
  }

  if (typeof body?.proposalId !== 'string' || body.proposalId === '') {
    return mobileError('proposalId is required');
  }
  if (!Array.isArray(body.accepted)) {
    return mobileError('accepted must be an array');
  }

  const accepted: AcceptedSuggestion[] = body.accepted
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      index: Number(entry.index),
      ...(typeof entry.content === 'string' ? { content: entry.content } : {}),
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0);

  try {
    const result = await confirmProfileSuggestions(user.uid, body.proposalId, accepted, new Date());
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ProposalNotFoundError) {
      return Response.json(
        { success: false, error: 'proposal not found', reason: 'proposal_not_found' },
        { status: 404 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the facts', 500);
  }
}

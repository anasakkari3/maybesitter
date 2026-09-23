import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { moduleDisabledResponse } from '../../../../../../../lib/services/mobile/moduleGate';
import {
  ImportProposalNotFoundError,
  confirmAiContextImport,
  type AcceptedImportCandidate,
} from '../../../../../../../lib/services/mobile/aiContextImportService';
import { mobileError } from '../../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

/**
 * Writes the candidates the user kept.
 *
 * This is the only path by which an imported profile becomes something the
 * product remembers. `POST /import` writes no memory record at all — closing
 * the review screen leaves nothing behind, which is the invariant this pair
 * exists to hold.
 *
 * No AI consent check here: nothing reaches a model on this path, and the
 * candidates were produced under a consent that was checked when they were
 * made. Re-checking would mean somebody who revoked mid-review loses the rows
 * they had already kept.
 *
 * `resolve` narrows to the two literals, and anything else becomes absent —
 * which means keep both. That is the direction that destroys nothing.
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

  const accepted: AcceptedImportCandidate[] = body.accepted
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      index: Number(entry.index),
      ...(typeof entry.content === 'string' ? { content: entry.content } : {}),
      ...resolveOf(entry.resolve),
    }))
    .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0);

  try {
    const result = await confirmAiContextImport(user.uid, body.proposalId, accepted, new Date());
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ImportProposalNotFoundError) {
      return Response.json(
        { success: false, error: 'proposal not found', reason: 'proposal_not_found' },
        { status: 404 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'could not save the facts', 500);
  }
}

/**
 * The two literals, or nothing. A value the client invented becomes absent,
 * which means keep both — the only direction that destroys no record.
 */
function resolveOf(raw: unknown): { resolve?: 'replace' | 'keep_both' } {
  if (raw === 'replace' || raw === 'keep_both') return { resolve: raw };
  return {};
}

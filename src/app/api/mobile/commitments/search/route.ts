import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveSearchHistory } from '../../../../../../lib/release/m6Capabilities';
import { searchCommitments } from '../../../../../../lib/services/mobile/commitmentSearchService';
import { commitmentToMobileDto } from '../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody } from '../../../../../../lib/net/requestBody';
import { foldForSearch } from '../../../../../text/foldForSearch';

export const dynamic = 'force-dynamic';

const SEARCH_BODY_LIMIT_BYTES = 2 * 1024;
const MAX_RAW_QUERY_LENGTH = 200;
const MAX_FOLDED_QUERY_LENGTH = 80;
const DEFAULT_LIMIT = 30;
const LETTER_OR_NUMBER = new RegExp('[\\p{L}\\p{N}]', 'u');

function invalid(reason: 'invalid_query' | 'invalid_limit'): Response {
  return Response.json({ success: false, error: reason, reason }, { status: 400 });
}

export async function POST(request: Request): Promise<Response> {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  // Gate before body parsing and, critically, before any account storage read.
  if (!resolveSearchHistory()) {
    return Response.json(
      { success: false, error: 'feature_unavailable', reason: 'feature_unavailable' },
      { status: 404 },
    );
  }

  let body: { q?: unknown; limit?: unknown };
  try {
    body = await readJsonBody(request, { limitBytes: SEARCH_BODY_LIMIT_BYTES }) as typeof body;
  } catch (error) {
    // An over-sized search body cannot contain a valid bounded query. Keep the
    // search contract's stable refusal while still stopping the read at 2 KiB.
    if (error instanceof RequestBodyTooLargeError) return invalid('invalid_query');
    return invalid('invalid_query');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid('invalid_query');
  if (typeof body.q !== 'string' || body.q.length > MAX_RAW_QUERY_LENGTH) return invalid('invalid_query');
  const foldedQuery = foldForSearch(body.q).trim();
  const foldedLength = Array.from(foldedQuery).length;
  if (foldedLength < 1 || foldedLength > MAX_FOLDED_QUERY_LENGTH || !LETTER_OR_NUMBER.test(foldedQuery)) {
    return invalid('invalid_query');
  }

  const limit = body.limit === undefined ? DEFAULT_LIMIT : body.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 50) {
    return invalid('invalid_limit');
  }

  const matches = await searchCommitments({ participantId: user.uid, foldedQuery });
  const shown = matches.slice(0, limit as number);
  return Response.json({
    success: true,
    items: shown.map((commitment) => ({
      ...commitmentToMobileDto(commitment),
      status: commitment.status === 'completed' ? 'done' : commitment.status,
    })),
    truncated: matches.length > shown.length,
  });
}

import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../lib/account/accountLiveness';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveEveningImpact } from '../../../../../../lib/release/m4bCapabilities';
import { answerEveningImpact } from '../../../../../../lib/planning/eveningImpactDecision';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  if (!resolveEveningImpact()) return Response.json({ success: false, error: 'feature_unavailable' }, { status: 404 });
  let body: unknown;
  try { body = await readJsonBody(request); } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  const value = body as Record<string, unknown> | null;
  if (!value || Array.isArray(value) || typeof value.proposalId !== 'string' || typeof value.itemId !== 'string'
    || !Number.isInteger(value.revision) || !['ready', 'not_ready', 'unsure'].includes(String(value.readiness))
    || Object.keys(value).some((key) => !['proposalId', 'revision', 'itemId', 'readiness'].includes(key))) {
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
  let result;
  try {
    result = await answerEveningImpact(user.uid, value as unknown as { proposalId: string; revision: number; itemId: string; readiness: 'ready' | 'not_ready' | 'unsure' });
  } catch (error) {
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    throw error;
  }
  if (result.kind === 'not_found') return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  if (result.kind === 'expired') return Response.json({ success: false, error: 'proposal_expired' }, { status: 410 });
  if (result.kind === 'changed') return Response.json({ success: false, error: 'proposal_changed', proposal: result.proposal }, { status: 409 });
  return Response.json(result.proposal);
}

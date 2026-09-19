import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { disconnectGoogle } from '../../../../../../../lib/integrations/gmail/production/googleConnectService';
import { getStorage } from '../../../../../../../lib/storage';
import { googleConnectErrorResponse } from '../connect/route';

export const dynamic = 'force-dynamic';

/**
 * Disconnect a Gmail account (Gmail Phase B).
 *
 * Revokes the grant at Google first, then deletes the stored credential, then
 * marks the connection revoked. A revocation Google refuses stops the whole
 * thing and leaves the connection in `error`: deleting our only copy of a token
 * Google still honours would leave a live grant nobody can see or withdraw.
 *
 * Shipping connect without this would be shipping a door that only opens one
 * way.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'invalid_request', reason: 'invalid_request' }, { status: 400 });
  }

  const connectionId = typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>).connectionId
    : null;
  if (typeof connectionId !== 'string' || connectionId.trim() === '') {
    return Response.json({ success: false, error: 'invalid_request', reason: 'invalid_request' }, { status: 400 });
  }

  try {
    const result = await disconnectGoogle(user.uid, connectionId, { storage: getStorage() });
    // A connection this account does not have is not an error to report as a
    // failure — but it must not read as "revoked", either.
    if (!result) {
      return Response.json({ success: false, error: 'not_found', reason: 'not_found' }, { status: 404 });
    }
    return Response.json({ success: true, ...result });
  } catch (error) {
    return googleConnectErrorResponse(error);
  }
}

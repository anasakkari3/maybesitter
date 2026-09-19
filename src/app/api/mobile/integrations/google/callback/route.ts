import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { completeGoogleConnect } from '../../../../../../../lib/integrations/gmail/production/googleConnectService';
import { getStorage } from '../../../../../../../lib/storage';
import { googleConnectErrorResponse } from '../connect/route';

export const dynamic = 'force-dynamic';

/**
 * Finish connecting a Gmail account (Gmail Phase B).
 *
 * **This is not the URL Google redirects to.** Google redirects the browser,
 * and a browser redirect carries no Firebase token; the app intercepts that
 * redirect, reads `code` and `state` from it, and posts them here signed in.
 * The uid therefore comes from the verified token and never from the body,
 * which is what stops a stolen code being redeemed into another account.
 *
 * Neither `code` nor `state` is logged or echoed back.
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

  const code = readString(body, 'code');
  const state = readString(body, 'state');
  if (!code || !state) {
    return Response.json({ success: false, error: 'invalid_request', reason: 'invalid_request' }, { status: 400 });
  }

  try {
    const connected = await completeGoogleConnect(user.uid, { code, state }, { storage: getStorage() });
    return Response.json({ success: true, ...connected });
  } catch (error) {
    return googleConnectErrorResponse(error);
  }
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { completeGoogleConnect, GoogleConnectError } from '../../../../../../../lib/integrations/google/googleConnectService';
import { googleFailureResponse, invalidGoogleRequest } from '../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../lib/integrations/google/googleRuntime';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Finish connecting: `{ code, state }` as the auth session handed them back,
 * or `{ error }` when the person said no at Google.
 *
 * **This is not the URL Google redirects to** (`/api/oauth/google/callback`
 * is). The uid comes from the verified token and never from the body, which is
 * what stops a stolen code being redeemed into another account. Neither
 * `code` nor `state` is logged or echoed back.
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
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return invalidGoogleRequest();
  }

  // "Cancel" on Google's consent screen. Nothing was granted and nothing is
  // stored; the in-flight state expires on its own.
  if (readString(body, 'error') !== null) return googleFailureResponse(new GoogleConnectError('google_access_denied'));

  const code = readString(body, 'code');
  const state = readString(body, 'state');
  if (!code || !state) return invalidGoogleRequest();

  try {
    return Response.json({ success: true, google: await completeGoogleConnect(user.uid, { code, state }, googleRuntime()) });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

function readString(body: unknown, key: string): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' && value.length <= 4096 ? value : null;
}

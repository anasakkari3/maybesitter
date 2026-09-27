import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { beginGoogleConnect } from '../../../../../../../lib/integrations/google/googleConnectService';
import { isGoogleFeature } from '../../../../../../../lib/integrations/google/googleConfig';
import { googleFailureResponse, invalidGoogleRequest } from '../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../lib/integrations/google/googleRuntime';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Start connecting one Google feature: `{ feature: 'calendar' | 'gmail' | 'drive' }`.
 *
 * Returns the URL the app opens in an auth session, and the app-scheme URL
 * that session waits for. The app then POSTs the `code` and `state` it was
 * handed to `/callback` with its own bearer — see `googleConnectService` for
 * why the exchange cannot happen on the browser's redirect.
 *
 * POST because it writes: every call mints a state and stores an in-flight
 * authorization.
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
  const feature = typeof body === 'object' && body !== null ? (body as { feature?: unknown }).feature : undefined;
  if (!isGoogleFeature(feature)) return invalidGoogleRequest();

  try {
    return Response.json({ success: true, ...(await beginGoogleConnect(user.uid, feature, googleRuntime())) });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

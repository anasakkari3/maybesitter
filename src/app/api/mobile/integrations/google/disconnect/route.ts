import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { disconnectGoogle, getGoogleStatus } from '../../../../../../../lib/integrations/google/googleConnectService';
import { googleFailureResponse } from '../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../lib/integrations/google/googleRuntime';

export const dynamic = 'force-dynamic';

/**
 * Disconnect Google: revoke at Google, delete the stored tokens, mark the
 * connection revoked, and remove the Google busy time — for all three
 * features at once, because they are one grant.
 *
 * A revocation Google refuses stops the whole thing and keeps the tokens: our
 * only copy of a grant Google still honours is the only way to withdraw it.
 * Takes no body: there is one Google connection per account, and its id is
 * derived on the server rather than read from a request.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  try {
    const runtime = googleRuntime();
    const result = await disconnectGoogle(user.uid, runtime);
    return Response.json({ success: true, ...result, google: await getGoogleStatus(user.uid, runtime) });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

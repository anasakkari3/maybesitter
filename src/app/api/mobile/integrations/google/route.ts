import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getGoogleStatus } from '../../../../../../lib/integrations/google/googleConnectService';
import { googleFailureResponse } from '../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../lib/integrations/google/googleRuntime';

export const dynamic = 'force-dynamic';

/**
 * What the three Google rows show (CL6a): `not_configured` until the owner has
 * put the OAuth client in Secret Manager, then `not_connected`, `connected` or
 * `needs_reauth`, with which features the grant carries.
 *
 * Nothing secret is in it: an address the person connected, three booleans,
 * whether the Picker key exists, and a date.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  try {
    return Response.json({ success: true, google: await getGoogleStatus(user.uid, googleRuntime()) });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

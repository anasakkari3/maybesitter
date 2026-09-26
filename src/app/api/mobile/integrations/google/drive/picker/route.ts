import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { beginDrivePick } from '../../../../../../../../lib/integrations/google/googleDrive';
import { googleFailureResponse } from '../../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../../lib/integrations/google/googleRuntime';

export const dynamic = 'force-dynamic';

/**
 * A one-time, two-minute link to the Google Picker page (CL6a).
 *
 * The page opens in the system browser, which has no Firebase token; this is
 * the authenticated step that lets it know whose Drive to show. The link holds
 * a ticket, never a token.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  try {
    return Response.json({ success: true, ...(await beginDrivePick(user.uid, googleRuntime())) });
  } catch (error) {
    return googleFailureResponse(error);
  }
}

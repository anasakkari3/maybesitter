import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { aiConsentView } from '../../../../../lib/consents/aiConsentService';
import { mobileError } from '../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

/**
 * What this account has agreed to (UC-2.1, #161).
 *
 * The client renders from this and never from its own storage: the server is
 * the only place consent lives, so a device that was offline when somebody
 * revoked on another device shows the revocation as soon as it asks.
 *
 * `asked` distinguishes "declined" from "never asked", which is the difference
 * between showing the consent card and respecting an answer already given.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    return Response.json(await aiConsentView(user.uid));
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not read consents', 500);
  }
}

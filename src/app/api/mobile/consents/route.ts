import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { allConsentsView } from '../../../../../lib/consents/consentService';
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
 *
 * Every consent the server knows about is answered here, not just the AI one
 * (UC-2.9, #170 added the recommendation question). One round trip, and the
 * onboarding screen cannot end up rendering one toggle from the server and
 * another from a guess. `currentVersion` is kept alongside `currentVersions`
 * so a client written against #161's shape keeps working.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const view = await allConsentsView(user.uid);
    return Response.json({ ...view, currentVersion: view.currentVersions.aiProcessing });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'could not read consents', 500);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveEveningImpact, resolveExternalClashHold, resolveSmartPostpone } from '../../../../../../lib/release/m4bCapabilities';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return Response.json({ success: true, externalClashHold: resolveExternalClashHold(), eveningImpact: resolveEveningImpact(), smartPostpone: resolveSmartPostpone() });
}

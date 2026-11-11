import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { featureCapabilities } from '../../../../../../lib/features/featureCapabilities';

export const dynamic = 'force-dynamic';

/**
 * The person's features: core and add-ons, whether each is usable now and how
 * much of this month's allowance it has used (owner direction, 2026-11-10).
 * Its own route rather than a key on the strict m4b/m5a/m6 bodies, which an
 * installed app would reject.
 */
export async function GET(request: Request): Promise<Response> {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  return Response.json(await featureCapabilities(user.uid));
}

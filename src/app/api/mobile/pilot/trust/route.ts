import {
  getMobilePilotTrust,
  mobilePilotErrorResponse,
  updateMobilePilotTrust,
} from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    return Response.json(await getMobilePilotTrust(user.uid));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

/**
 * `forceRevocationCheck` on purpose: this is the route a `revoke` or `delete`
 * action arrives on, and the 60 s revocation cache is not good enough for the
 * destructive paths. The action is only knowable after the body is read, and
 * the body must not be read before the caller is authenticated, so the whole
 * write route pays the extra `getUser` rather than guessing. It is a
 * low-volume endpoint; correctness is worth the round trip.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request, { forceRevocationCheck: true });
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    return Response.json(await updateMobilePilotTrust(user.uid, body));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

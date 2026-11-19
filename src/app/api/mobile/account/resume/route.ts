import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobilePilotErrorResponse, resumeRevokedAccount } from '../../../../../../lib/services/mobile/pilotService';

export const dynamic = 'force-dynamic';

/**
 * «رجّع حسابي» — bring back an account the old «وقّف» locked (QA v3).
 *
 * `allowRevoked`: this is the one route whose whole point is a revoked
 * account; every other route still refuses one. `forceRevocationCheck`: it
 * changes what the account may do, so revocation state is read now, not off
 * the 60 s cache. A deleted account is still refused by the guard.
 *
 * No body is read. The account is the verified token's and nobody else's: a
 * field naming another account would be the one thing never to trust here.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request, { forceRevocationCheck: true, allowRevoked: true });
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    return Response.json(await resumeRevokedAccount(user.uid));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

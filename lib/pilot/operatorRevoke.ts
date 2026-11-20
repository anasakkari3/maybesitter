/**
 * The operator's «إنهاء وصول» for one account (UC-1.0e #144; review of #883).
 *
 * Two steps, in this order and both required:
 *
 *   1. `revokeRefreshTokens` stamps the account's `tokensValidAfterTime`, so
 *      every ID token issued before this moment stops verifying and the
 *      client cannot mint a new one from its refresh token.
 *   2. The trust `revoke`, marked `by: 'operator'`, stamps `revokedAt` and
 *      `revokedBy: 'operator'` on `users/{uid}`. `requireMobileUser` reads
 *      the first; the mark is what keeps «رجّع حسابي»
 *      (`POST /api/mobile/account/resume`) from lifting it: the person may
 *      sign in again, but the account stays stopped until an operator acts.
 *
 * Here rather than in the script so the path is the one the tests run.
 */
import { applyTrustAction } from './pilotTrustStore';
import { requireUserId } from '../storage/paths';
import type { PilotTrustState } from './closedPilotControls';

export interface OperatorRevokeAuth {
  revokeRefreshTokens(uid: string): Promise<void>;
}

export async function revokeAccountAsOperator(
  uid: string,
  auth: OperatorRevokeAuth,
  now: () => Date = () => new Date(),
): Promise<PilotTrustState> {
  requireUserId(uid);
  await auth.revokeRefreshTokens(uid);
  return applyTrustAction(uid, { type: 'revoke', at: now().toISOString(), by: 'operator' });
}

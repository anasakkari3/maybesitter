/**
 * Cut one user off, now (UC-1.0e, #144).
 *
 * Two steps, in this order and both required (`revokeAccountAsOperator`,
 * lib/pilot/operatorRevoke.ts):
 *
 *   1. `revokeRefreshTokens` stamps the account's `tokensValidAfterTime`, so
 *      every ID token issued before this moment stops verifying and the
 *      client cannot mint a new one from its refresh token.
 *   2. The trust `revoke` action, marked `by: 'operator'`, stamps `revokedAt`
 *      and `revokedBy: 'operator'` on `users/{uid}`. `requireMobileUser` reads
 *      the first and refuses with `revoked`; the mark is what stops the
 *      account lifting it from the app with «رجّع حسابي» (review of #883).
 *
 * Step 1 alone would let an already-issued token keep working for up to the
 * 60 s revocation-cache window; step 2 alone would leave the credential live
 * for anything that has not yet been moved behind the trust check. Doing both
 * is what makes the refusal immediate and total.
 *
 * Replaces `scripts/revoke-participant.ts`, which only did step 2 because
 * there was no account to revoke — the HMAC token it guarded never expired.
 *
 * Usage:
 *   GOOGLE_CLOUD_PROJECT=<project> MAYBESITTER_STORAGE_BACKEND=firestore \
 *     node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/revoke-user.ts <uid>
 */
import { getAuth } from 'firebase-admin/auth';
import { getAdminApp } from '../lib/firebase/admin';
import { revokeAccountAsOperator } from '../lib/pilot/operatorRevoke';
import { requireUserId } from '../lib/storage/paths';

async function main() {
  const uid = process.argv[2];
  if (!uid) {
    console.error('Usage: node --no-warnings --loader ./scripts/ts-resolver.mjs scripts/revoke-user.ts <uid>');
    process.exit(1);
  }

  try {
    requireUserId(uid);
    const auth = getAuth(getAdminApp());
    const state = await revokeAccountAsOperator(uid, { revokeRefreshTokens: (id) => auth.revokeRefreshTokens(id) });
    console.log(`Revoked refresh tokens and trust for [${uid}] at ${state.revokedAt}`);
    console.log('Updated trust state:', state);
  } catch (error) {
    console.error('Error revoking user:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

void main();

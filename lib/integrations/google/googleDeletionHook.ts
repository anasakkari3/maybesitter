/**
 * Deleting the account withdraws the Google grant too (CL6a; council blind
 * spot 6).
 *
 * The tokens, the connection record and the busy blocks are all inside
 * `users/{uid}` and go with the tree. What the tree cannot take with it is the
 * grant itself: a refresh token Google still honours is a door into the
 * person's calendar and mail that outlives the account. So this revokes it at
 * Google first, through the same disconnect every "Disconnect" button uses.
 *
 * Registered on import by the account-deletion route. A failure is recorded on
 * the receipt as `externalRevocations: failed` and the deletion goes on, which
 * is the deletion engine's rule for every external system (`deletionHooks.ts`).
 * With nothing connected there is nothing to revoke and the hook succeeds
 * without calling anyone. With a grant stored but Google no longer configured
 * the hook fails, so the receipt records the revocation as failed.
 */
import { registerDeletionHook } from '../../account/deletionHooks';
import { disconnectGoogle, getGoogleStatus, hasLiveGoogleConnection } from './googleConnectService';
import { googleRuntime } from './googleRuntime';

export const GOOGLE_DELETION_HOOK = 'googleRevoke';

export async function revokeGoogleForDeletedAccount(uid: string): Promise<void> {
  const runtime = googleRuntime();
  const status = await getGoogleStatus(uid, runtime);
  if (status.status === 'not_configured') {
    // The client secret or the KMS key went away after somebody connected.
    // Their grant is still live at Google and nothing here can revoke it, so
    // this is a failed revocation, not a finished one: the receipt must say
    // `failed` rather than `done` (CL6a review m1).
    if (await hasLiveGoogleConnection(uid, runtime)) {
      throw new Error('google grant is stored but google is not configured: it cannot be revoked');
    }
    return;
  }
  if (status.status === 'not_connected') return;
  await disconnectGoogle(uid, runtime);
}

registerDeletionHook(GOOGLE_DELETION_HOOK, revokeGoogleForDeletedAccount);

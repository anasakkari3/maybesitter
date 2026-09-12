import { apiRequest } from '../client';
import { accountDeletionResponseSchema, DELETION_CONFIRMATION, type DeletionReceipt } from '../schemas/account';

/**
 * Deletes the account, permanently (UC-1.5 #149).
 *
 * Three things this deliberately does not do:
 *
 *  - **it is never retried automatically.** There is no generic mutation
 *    retry for it and no queue. A deletion replayed without the user present
 *    is the one mistake in this product that cannot be undone;
 *  - **it does not catch `recent_login_required`.** That 401 is thrown as
 *    `RecentLoginRequiredError` by the client, and the caller's job is to
 *    re-authenticate and ask again deliberately;
 *  - **nothing runs after it succeeds.** The server has deleted the Firebase
 *    user by the time this resolves, so the token in hand is already dead and
 *    any further authenticated call would answer 401 — which the generic path
 *    would read as an expired session.
 */
export async function deleteAccount(): Promise<DeletionReceipt> {
  const result = await apiRequest('DELETE', '/api/mobile/account', {
    body: { confirmation: DELETION_CONFIRMATION },
    schema: accountDeletionResponseSchema,
  });
  return result.receipt;
}

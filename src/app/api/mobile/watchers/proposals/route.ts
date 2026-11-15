import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../lib/account/accountLiveness';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { listOpenWatcherProposals } from '../../../../../../lib/services/mobile/watcherProposalService';

export const dynamic = 'force-dynamic';

/**
 * The owner's open «اقترح التزام» proposals (QA CA6.1), newest first, at most
 * 20. Identifiers and the kind of watch only; the app writes the words.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  try {
    return Response.json({ success: true, proposals: await listOpenWatcherProposals(user.uid) });
  } catch (error) {
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    console.error('[watchers] listing proposals failed', error instanceof Error ? error.name : 'unknown');
    return mobileError('could not list watcher proposals', 500);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { listBackgroundActivity } from '../../../../../../lib/watchers/backgroundMonitors';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/trust/background-activity` (#527).
 *
 * What this app is watching for the signed-in account, and what it is allowed
 * to do about it. A read projection over Watchers (#525) and their connection
 * records — no store of its own, and nothing here starts, stops or schedules
 * any work.
 *
 * The account is the token's. `listBackgroundActivity(user.uid)` builds every
 * path from the verified uid, exactly as `GET /api/mobile/watchers` does, so
 * there is no parameter that could name another account's tree: another
 * account's monitors are not filtered out of this answer, they were never in
 * the collections it reads.
 *
 * Pausing and deleting stay on `/api/mobile/watchers/{id}` and are not
 * duplicated here. This answer reports whether each is available
 * (`canPause`, `canDelete`); the verbs have one home.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    const activity = await listBackgroundActivity(user.uid, new Date().toISOString());
    return Response.json({ success: true, ...activity });
  } catch (error) {
    console.error('[trust] listing background activity failed', error);
    return mobileError('could not read your background activity', 500);
  }
}

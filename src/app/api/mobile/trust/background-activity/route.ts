import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { listBackgroundActivity } from '../../../../../../lib/watchers/backgroundMonitors';
import { saveMonitoringSettings } from '../../../../../../lib/watchers/monitoringSettings';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

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
 * Pausing and deleting individual watchers stay on `/api/mobile/watchers/{id}`.
 * Global account-level background monitoring pause is controlled here via PATCH.
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

/**
 * `PATCH /api/mobile/trust/background-activity` (#527).
 *
 * Pauses or resumes background monitoring globally for the account.
 */
export async function PATCH(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return mobileError('body must be an object');
  }

  const payload = body as Record<string, unknown>;
  const allowedKeys = ['paused', 'monitoringPaused'];
  const keys = Object.keys(payload);
  if (keys.some((key) => !allowedKeys.includes(key))) {
    return mobileError('unrecognized field in request');
  }

  const paused = payload.paused ?? payload.monitoringPaused;
  if (typeof paused !== 'boolean') {
    return mobileError('paused must be a boolean');
  }

  try {
    await saveMonitoringSettings(user.uid, paused);
    const activity = await listBackgroundActivity(user.uid, new Date().toISOString());
    return Response.json({ success: true, ...activity });
  } catch (error) {
    console.error('[trust] updating background monitoring status failed', error);
    return mobileError('could not update background monitoring', 500);
  }
}

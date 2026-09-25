import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  readMonitoringSettings,
  saveMonitoringSettings,
} from '../../../../../../lib/watchers/monitoringSettings';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/settings/monitoring` (#527).
 *
 * Reads the account's background monitoring settings.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const settings = await readMonitoringSettings(user.uid);
  return Response.json({
    success: true,
    monitoringSettings: settings,
    paused: settings.paused,
  });
}

/**
 * `PATCH /api/mobile/settings/monitoring` (#527).
 *
 * Updates the account's background monitoring settings.
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
    const settings = await saveMonitoringSettings(user.uid, paused);
    return Response.json({
      success: true,
      monitoringSettings: settings,
      paused: settings.paused,
    });
  } catch (error) {
    console.error('[settings] saving monitoring settings failed', error);
    return mobileError('could not save monitoring settings', 500);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../lib/services/mobile/response';
import {
  DeviceValidationError,
  parseDeviceRegistration,
  upsertDevice,
} from '../../../../../lib/push/deviceRegistry';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Registers this phone for push (UC-3.0b, #184).
 *
 * The account is the token's. There is no uid parameter on `upsertDevice` that
 * a body could reach, and `parseDeviceRegistration` returns a type with no uid
 * on it — so "the body cannot choose the tree" is a property of the shapes
 * rather than of this handler remembering to ignore a field.
 *
 * A `uid` in the body is dropped rather than refused, because the issue's own
 * table told clients to send one; every other unknown key is a 400, because a
 * client sending a field this route does not know is about to be quietly
 * disappointed about something.
 *
 * Idempotent on `installationId`, which is what lets the app re-register on
 * every token refresh and on every cold start without accumulating rows.
 */
export async function POST(request: Request) {
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

  try {
    const registration = parseDeviceRegistration(body);
    await upsertDevice(user.uid, registration, new Date().toISOString());
    return Response.json({ success: true, ok: true });
  } catch (error) {
    if (error instanceof DeviceValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not register the device', 500);
  }
}

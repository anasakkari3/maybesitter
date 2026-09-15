import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { DeviceValidationError, deleteDevice } from '../../../../../../lib/push/deviceRegistry';

export const dynamic = 'force-dynamic';

/**
 * Forgets this phone (UC-3.0b, #184).
 *
 * Called on sign-out, while the token is still good — which is the only moment
 * it can be called at all, and the reason the app does it *before* it signs
 * out rather than after. An expired session cannot delete its own device row;
 * the account-deletion cascade (UC-1.5, #149) and FCM's own
 * `registration-token-not-registered` are what cover that case.
 *
 * Answers 200 whether or not there was a document. A sign-out that reports a
 * 404 would make the client decide whether to retry something already true.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ installationId: string }> },
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { installationId } = await context.params;
  try {
    const existed = await deleteDevice(user.uid, installationId);
    return Response.json({ success: true, ok: true, existed });
  } catch (error) {
    if (error instanceof DeviceValidationError) {
      return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
    }
    return mobileError(error instanceof Error ? error.message : 'could not forget the device', 500);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { setFeaturePreference } from '../../../../../../../lib/features/accountFeatures';
import { featureManifest, isFeatureId } from '../../../../../../../lib/features/catalog';
import { featureCapabilities } from '../../../../../../../lib/features/featureCapabilities';
import {
  RequestBodyTooLargeError,
  readJsonBody,
  requestBodyTooLargeResponse,
} from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

interface RouteContext { params: Promise<{ id: string }> }

/**
 * The person switches one add-on on or off (`{ enabled: boolean }`). Core
 * features are refused: the app works only with them. Answers the whole
 * feature list, so the screen redraws from one response.
 */
export async function PUT(request: Request, context: RouteContext): Promise<Response> {
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const { id } = await context.params;
  if (!isFeatureId(id)) {
    return Response.json({ success: false, error: 'not found', reason: 'unknown_feature' }, { status: 404 });
  }
  if (!featureManifest(id).userCanDisable) {
    return Response.json({ success: false, error: 'core feature', reason: 'not_switchable' }, { status: 400 });
  }
  let body: unknown;
  try { body = await readJsonBody(request, { limitBytes: 256 }); } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, error: 'invalid body', reason: 'invalid_body' }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') {
    return Response.json({ success: false, error: 'invalid body', reason: 'invalid_body' }, { status: 400 });
  }
  await setFeaturePreference(user.uid, id, enabled);
  return Response.json(await featureCapabilities(user.uid));
}

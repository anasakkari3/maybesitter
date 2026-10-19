import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../../../lib/consents/aiConsentService';
import { googleFailureResponse } from '../../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../../lib/integrations/google/googleRuntime';
import { intelligenceDisabledResponse } from '../../../../../../../../lib/intelligence/gate';
import { scanGmailIntelligence } from '../../../../../../../../lib/intelligence/googleGmailIntelligence';
import { readJsonBody } from '../../../../../../../../lib/net/requestBody';
import { resolveM5aCapabilities } from '../../../../../../../../lib/release/m5aControls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  let body: Record<string, unknown> = {};
  if (request.headers.get('content-type')?.includes('application/json')) {
    try { body = await readJsonBody<Record<string, unknown>>(request); }
    catch { return Response.json({ success: false, error: 'invalid_request' }, { status: 400 }); }
  }
  if (body.m5 === true && !(await resolveM5aCapabilities()).emailSources) {
    return Response.json({ success: false, error: 'm5_unavailable' }, { status: 409 });
  }
  if (await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  try {
    return Response.json({ success: true, ...await scanGmailIntelligence(user.uid, googleRuntime()) });
  } catch (error) { return googleFailureResponse(error); }
}

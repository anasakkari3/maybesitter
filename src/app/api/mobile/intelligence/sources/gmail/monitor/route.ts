import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../../../lib/consents/aiConsentService';
import { googleFailureResponse } from '../../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../../lib/integrations/google/googleRuntime';
import { intelligenceDisabledResponse } from '../../../../../../../../lib/intelligence/gate';
import { readGmailMonitor, setGmailMonitor } from '../../../../../../../../lib/intelligence/gmailMonitor';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../../lib/net/requestBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  const monitor = await readGmailMonitor(user.uid);
  return Response.json({ success: true, enabled: monitor?.enabled ?? false,
    lastSuccessAt: monitor?.lastSuccessAt ?? null, error: monitor?.error ?? null });
}

export async function POST(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return disabled;
  let user;
  try { user = await requireMobileUser(request); } catch (error) { return mobileAuthErrorResponse(error); }
  let body: unknown;
  try { body = await readJsonBody(request); } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return Response.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  }
  const enabled = (body as { enabled?: unknown } | null)?.enabled;
  if (typeof enabled !== 'boolean') return Response.json({ success: false, reason: 'invalid_body' }, { status: 400 });
  if (enabled && await getAiConsent(user.uid) !== 'granted') {
    return Response.json({ success: false, reason: 'consent_required' }, { status: 403 });
  }
  try {
    const monitor = await setGmailMonitor(user.uid, enabled, googleRuntime());
    return Response.json({ success: true, enabled: monitor.enabled, lastSuccessAt: monitor.lastSuccessAt, error: monitor.error });
  } catch (error) { return googleFailureResponse(error); }
}

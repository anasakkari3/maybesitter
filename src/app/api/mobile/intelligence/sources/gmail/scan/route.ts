import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { getAiConsent } from '../../../../../../../../lib/consents/aiConsentService';
import { googleFailureResponse } from '../../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../../lib/integrations/google/googleRuntime';
import { intelligenceDisabledResponse } from '../../../../../../../../lib/intelligence/gate';
import { scanGmailIntelligence } from '../../../../../../../../lib/intelligence/googleGmailIntelligence';
import {
  publicQueued,
  publicDailyStatus,
  publicScanStatus,
  readM5aDailyScan,
  readM5aScan,
  startOrResumeM5aScan,
} from '../../../../../../../../lib/intelligence/m5aGmailScan';
import { readJsonBody } from '../../../../../../../../lib/net/requestBody';
import { resolveM5aCapabilities } from '../../../../../../../../lib/release/m5aControls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAILY_LIMIT_CLIENT_FEATURE = 'gmail-scan-daily-limit';
const BULK_CLIENT_FEATURE = 'gmail-scan-bulk';

function supportsFeature(request: Request, wanted: string): boolean {
  return (request.headers.get('X-MaybeSitter-Client-Features') ?? '')
    .split(',')
    .some(feature => feature.trim().toLowerCase() === wanted);
}

async function authenticated(request: Request) {
  const disabled = intelligenceDisabledResponse();
  if (disabled) return { response: disabled } as const;
  try {
    const user = await requireMobileUser(request);
    if (await getAiConsent(user.uid) !== 'granted') {
      return { response: Response.json({ success: false, reason: 'consent_required' }, { status: 403 }) } as const;
    }
    return { user } as const;
  } catch (error) { return { response: mobileAuthErrorResponse(error) } as const; }
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authenticated(request);
  if ('response' in auth) return auth.response as Response;
  if (!(await resolveM5aCapabilities()).emailSources) {
    return Response.json({ success: false, error: 'not_found' }, { status: 404 });
  }
  const [scan, daily] = await Promise.all([
    readM5aScan(auth.user.uid, googleRuntime().storage),
    readM5aDailyScan(auth.user.uid, googleRuntime().storage),
  ]);
  const dailyLimit = supportsFeature(request, DAILY_LIMIT_CLIENT_FEATURE);
  const bulk = supportsFeature(request, BULK_CLIENT_FEATURE);
  return Response.json({ success: true, manual: publicScanStatus(scan, dailyLimit, bulk), queuedManual: publicQueued(scan), daily: publicDailyStatus(daily, dailyLimit, bulk) });
}

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
  if (body.m5 === true) {
    const intent = body.intent;
    if ((intent !== 'new' && intent !== 'resume')
      || (body.expectedScanId !== undefined && typeof body.expectedScanId !== 'string')
      || (body.origin !== undefined && body.origin !== 'manual' && body.origin !== 'backfill')
      || (body.timezone !== undefined && typeof body.timezone !== 'string')) {
      return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
    }
    try {
      const scan = await startOrResumeM5aScan(user.uid, {
        intent,
        ...(typeof body.expectedScanId === 'string' ? { expectedScanId: body.expectedScanId } : {}),
        ...(body.origin === 'manual' || body.origin === 'backfill' ? { origin: body.origin } : {}),
        ...(typeof body.timezone === 'string' ? { timezone: body.timezone } : {}),
      }, googleRuntime());
      const daily = await readM5aDailyScan(user.uid, googleRuntime().storage);
      const dailyLimit = supportsFeature(request, DAILY_LIMIT_CLIENT_FEATURE);
      const bulk = supportsFeature(request, BULK_CLIENT_FEATURE);
      return Response.json({
        success: true, messagesRead: 0, observations: [], scan: publicScanStatus(scan, dailyLimit, bulk),
        manual: publicScanStatus(scan, dailyLimit, bulk), queuedManual: publicQueued(scan), daily: publicDailyStatus(daily, dailyLimit, bulk),
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'm5_unavailable') {
        return Response.json({ success: false, error: 'm5_unavailable' }, { status: 409 });
      }
      return googleFailureResponse(error);
    }
  }
  try {
    return Response.json({ success: true, ...await scanGmailIntelligence(user.uid, googleRuntime()) });
  } catch (error) { return googleFailureResponse(error); }
}

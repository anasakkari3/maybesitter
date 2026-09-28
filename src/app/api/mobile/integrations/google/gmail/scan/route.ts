import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { recordTraceStage, stage } from '../../../../../../../../lib/alphaTrace/traceRecorder';
import { shareTraceSessionId } from '../../../../../../../../lib/services/share/shareIntakeService';
import { scanRecentGmail } from '../../../../../../../../lib/integrations/google/googleGmailScan';
import { googleFailureResponse, invalidGoogleRequest } from '../../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../../lib/integrations/google/googleRuntime';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../../lib/net/requestBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «جيب التزامات من إيميلي»: the last seven days of Primary, at most twenty
 * messages, read once into one capture proposal (CL6a). Body: `{ timezone,
 * referenceTime }`, both optional.
 *
 * The answer has exactly the shape `/api/mobile/capture/share` returns, so the
 * app reviews it on the same screen. The trace records counts — messages read,
 * items proposed — and never a subject, an address or a sentence.
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
    return invalidGoogleRequest();
  }
  const fields = typeof body === 'object' && body !== null ? body as { timezone?: unknown; referenceTime?: unknown } : {};

  try {
    const result = await scanRecentGmail(
      user.uid,
      { timezone: fields.timezone, referenceTime: fields.referenceTime },
      googleRuntime(),
      { signal: request.signal },
    );
    try {
      await recordTraceStage(shareTraceSessionId(), user.uid, stage('extraction_completed', {
        surface: 'gmail_scan',
        disposition: result.status ?? 'unknown',
        itemCount: Array.isArray(result.items) ? result.items.length : 0,
        messagesRead: result.share.metrics.messagesRead ?? 0,
        ignoredSegments: result.share.ignoredSegments,
      }));
    } catch {
      // Instrumentation must never break the product path.
    }
    if (result.status === 'rejected') return invalidGoogleRequest();
    return Response.json(result);
  } catch (error) {
    return googleFailureResponse(error);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../../lib/auth/mobileAuth';
import { recordTraceStage, stage } from '../../../../../../../../lib/alphaTrace/traceRecorder';
import { shareTraceSessionId } from '../../../../../../../../lib/services/share/shareIntakeService';
import { importDriveFile } from '../../../../../../../../lib/integrations/google/googleDrive';
import { googleFailureResponse, invalidGoogleRequest } from '../../../../../../../../lib/integrations/google/googleRouteSupport';
import { googleRuntime } from '../../../../../../../../lib/integrations/google/googleRuntime';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../../../lib/net/requestBody';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read the one file the person picked into a capture proposal (CL6a). Body:
 * `{ fileId, timezone?, referenceTime?, locale? }`.
 *
 * The same answer `/api/mobile/capture/share` gives for a PDF from Files, so
 * the app reviews it on the same screen. The trace records a byte count and a
 * disposition, never a file name or a sentence.
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
  const fields = typeof body === 'object' && body !== null
    ? body as { fileId?: unknown; timezone?: unknown; referenceTime?: unknown; locale?: unknown }
    : {};

  try {
    const result = await importDriveFile(
      user.uid,
      { fileId: fields.fileId, timezone: fields.timezone, referenceTime: fields.referenceTime, locale: fields.locale },
      googleRuntime(),
      { signal: request.signal },
    );
    try {
      await recordTraceStage(shareTraceSessionId(), user.uid, stage('extraction_completed', {
        surface: 'drive_import',
        disposition: result.status ?? 'unknown',
        itemCount: Array.isArray(result.items) ? result.items.length : 0,
        totalBytes: result.share.totalBytes,
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

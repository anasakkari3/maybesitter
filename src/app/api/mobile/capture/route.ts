import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { proposeMobileCapture } from '../../../../../lib/services/mobile/mobileCaptureService';
import { CaptureInputTooLargeError } from '../../../../../lib/services/captureBoundary/captureBoundaryService';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../lib/alphaTrace/traceRecorder';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }
  // `null`, a number or an array is JSON too, and reading `.sessionId` off
  // `null` was a 500. The same 400 as a body that is not JSON at all.
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mobileError('Invalid JSON request body');

  // The scope is the uid. This route used to fall back to a single shared
  // participant literal, on one global state, whenever no pilot environment
  // was configured; there is no such fallback left to reach.
  const uid = user.uid;
  const sessionId = resolveTraceSessionId(body.sessionId, uid);

  try {
    await recordTraceStage(sessionId, uid, stage('input_received', { inputText: typeof body.text === 'string' ? body.text.slice(0, 2000) : '' }));
    const proposal = await proposeMobileCapture(body, { participantId: uid });
    if (proposal.status === 'rejected') {
      await recordTraceStage(sessionId, uid, stage('extraction_completed', { engine: 'rejected', disposition: 'rejected', title: null }));
      return mobileError('Capture rejected');
    }
    try {
      const item = Array.isArray(proposal.items) ? proposal.items[0] : undefined;
      await recordTraceStage(sessionId, uid, stage('extraction_completed', {
        engine: proposal.provenance?.executedEngine ?? 'unknown',
        fallbackUsed: proposal.provenance?.fallbackUsed ?? false,
        disposition: proposal.status ?? 'unknown',
        title: (item as { title?: string | null } | undefined)?.title ?? null,
        needsClarification: (item as { needsClarification?: boolean } | undefined)?.needsClarification ?? false,
      }));
    } catch {
      // trace recording must never break the product path
    }
    return Response.json(proposal);
  } catch (error) {
    /*
     * 413 with `maxCharacters`, which is the shape the phone already reads:
     * `mobile/src/api/client.ts:248` turns any 413 into `InputTooLargeError`
     * and `userFacingMessage.ts:118` renders that as `aiInputTooLong`, which
     * exists in en, ar and he. The reason code is `text_too_long`, the one the
     * share route already mints for the same refusal
     * (lib/services/share/shareIntakeService.ts:354), so the two doors onto
     * this boundary answer with one vocabulary.
     *
     * This mapping is why the error is typed. The catch below returns a bare
     * 400 with no `reason` at all, so a plain `throw new Error` here would be
     * indistinguishable from any other capture failure (#508).
     */
    if (error instanceof CaptureInputTooLargeError) {
      return Response.json(
        { success: false, error: error.message, reason: 'text_too_long', maxCharacters: error.maxCharacters },
        { status: 413 },
      );
    }
    return mobileError(error instanceof Error ? error.message : 'Capture failed');
  }
}

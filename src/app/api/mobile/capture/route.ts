import { mobileAuthErrorResponse, optionalMobilePilotAuth } from '../../../../../lib/services/mobile/auth';
import { proposeMobileCapture } from '../../../../../lib/services/mobile/mobileCaptureService';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let auth;
  try {
    auth = optionalMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  const participantId = auth?.participantId ?? 'anonymous';
  const sessionId = resolveTraceSessionId(body.sessionId, participantId);

  try {
    recordTraceStage(sessionId, participantId, stage('input_received', { inputText: typeof body.text === 'string' ? body.text.slice(0, 2000) : '' }));
    const proposal = await proposeMobileCapture(body, auth ?? {});
    if (proposal.status === 'rejected') {
      recordTraceStage(sessionId, participantId, stage('extraction_completed', { engine: 'rejected', disposition: 'rejected', title: null }));
      return mobileError('Capture rejected');
    }
    try {
      const item = Array.isArray(proposal.items) ? proposal.items[0] : undefined;
      recordTraceStage(sessionId, participantId, stage('extraction_completed', {
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
    return mobileError(error instanceof Error ? error.message : 'Capture failed');
  }
}

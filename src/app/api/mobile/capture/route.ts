import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';
import { proposeMobileCapture } from '../../../../../lib/services/mobile/mobileCaptureService';
import { mobileError } from '../../../../../lib/services/mobile/response';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../lib/alphaTrace/traceRecorder';

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
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  // The scope is the uid. This route used to fall back to a single shared
  // participant literal, on one global state, whenever no pilot environment
  // was configured; there is no such fallback left to reach.
  const uid = user.uid;
  const sessionId = resolveTraceSessionId(body.sessionId, uid);

  try {
    recordTraceStage(sessionId, uid, stage('input_received', { inputText: typeof body.text === 'string' ? body.text.slice(0, 2000) : '' }));
    const proposal = await proposeMobileCapture(body, { participantId: uid });
    if (proposal.status === 'rejected') {
      recordTraceStage(sessionId, uid, stage('extraction_completed', { engine: 'rejected', disposition: 'rejected', title: null }));
      return mobileError('Capture rejected');
    }
    try {
      const item = Array.isArray(proposal.items) ? proposal.items[0] : undefined;
      recordTraceStage(sessionId, uid, stage('extraction_completed', {
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

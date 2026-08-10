import { mobilePilotErrorResponse, recordMobileNextStepDecision } from '../../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../../lib/services/mobile/auth';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    const result = await recordMobileNextStepDecision(auth.participantId, body);
    try {
      const decision = typeof body.decision === 'string' ? body.decision : 'unknown';
      const originalTitle = typeof body.originalTitle === 'string' ? body.originalTitle : undefined;
      const editedTitle = typeof body.editedTitle === 'string' ? body.editedTitle : undefined;
      const payload: Record<string, unknown> = {
        proposalId: typeof body.proposalId === 'string' ? body.proposalId : null,
        decision,
      };
      if (decision === 'edit' && (originalTitle || editedTitle)) {
        payload.originalTitle = originalTitle ?? null;
        payload.editedTitle = editedTitle ?? null;
      }
      recordTraceStage(
        resolveTraceSessionId(body.sessionId, auth.participantId),
        auth.participantId,
        stage('proposal_decided', payload),
      );
    } catch {
      // trace recording must never break the product path
    }
    return Response.json(result);
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

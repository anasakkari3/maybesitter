import { mobilePilotErrorResponse, recordMobileNextStepDecision } from '../../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../../../lib/alphaTrace/traceRecorder';

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
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    const result = await recordMobileNextStepDecision(user.uid, body);
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
      await recordTraceStage(
        resolveTraceSessionId(body.sessionId, user.uid),
        user.uid,
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

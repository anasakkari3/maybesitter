import { getMobileNextStep, mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../lib/services/mobile/auth';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const startedAt = Date.now();
  try {
    const result = await getMobileNextStep(auth.participantId, Object.fromEntries(searchParams.entries()));
    try {
      recordTraceStage(
        resolveTraceSessionId(searchParams.get('sessionId'), auth.participantId),
        auth.participantId,
        stage('recommendation_generated', {
          proposalId: result.recommendation?.proposalId ?? null,
          state: result.recommendation?.state ?? 'unknown',
          primaryStep: result.recommendation?.primaryStep?.title ?? null,
          arm: result.assignment?.arm ?? 'unknown',
          latencyMs: Date.now() - startedAt,
        }),
      );
    } catch {
      // trace recording must never break the product path
    }
    return Response.json(result);
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

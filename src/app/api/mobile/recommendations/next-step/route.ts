import { getMobileNextStep, mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { recordTraceStage, resolveTraceSessionId, stage } from '../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const startedAt = Date.now();
  try {
    const result = await getMobileNextStep(user.uid, Object.fromEntries(searchParams.entries()));
    try {
      await recordTraceStage(
        resolveTraceSessionId(searchParams.get('sessionId'), user.uid),
        user.uid,
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

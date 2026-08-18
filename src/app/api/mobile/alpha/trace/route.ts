import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../lib/services/mobile/auth';
import { mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { getTraceStore, isTraceEnabled } from '../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/alpha/trace?sessionId=... — internal alpha review endpoint.
 * Requires pilot auth. Returns the full trace for one session, or summaries.
 */
export async function GET(request: Request) {
  if (!isTraceEnabled()) {
    return mobilePilotErrorResponse(new Error('feature_disabled'));
  }
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const store = getTraceStore();

  if (sessionId) {
    const trace = store.get(sessionId);
    if (!trace) return mobilePilotErrorResponse(new Error('session_not_found'));
    // Access boundary: participant may read own session; owner may read any.
    if (trace.participantId !== auth.participantId && process.env.MAYBESITTER_ALPHA_TRACE_OWNER_ID !== auth.participantId) {
      return mobilePilotErrorResponse(new Error('forbidden'));
    }
    return Response.json({ trace });
  }

  const withFeedbackOnly = searchParams.get('withFeedbackOnly') === 'true';
  const summaries = store.listSummaries({ participantId: auth.participantId, withFeedbackOnly });
  return Response.json({ summaries, count: summaries.length });
}

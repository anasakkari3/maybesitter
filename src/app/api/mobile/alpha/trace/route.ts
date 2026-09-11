import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { getTraceStore, isTraceEnabled } from '../../../../../../lib/alphaTrace/traceRecorder';

export const dynamic = 'force-dynamic';

/**
 * GET /api/mobile/alpha/trace?sessionId=... — internal alpha review endpoint.
 * Requires a verified Firebase ID token. Returns the full trace for one
 * session, or summaries.
 */
export async function GET(request: Request) {
  if (!isTraceEnabled()) {
    return mobilePilotErrorResponse(new Error('feature_disabled'));
  }
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const store = getTraceStore();

  if (sessionId) {
    const trace = store.get(sessionId);
    if (!trace) return mobilePilotErrorResponse(new Error('session_not_found'));
    // Access boundary: a user may read their own session; the owner may read any.
    if (trace.participantId !== user.uid && process.env.MAYBESITTER_ALPHA_TRACE_OWNER_ID !== user.uid) {
      return mobilePilotErrorResponse(new Error('forbidden'));
    }
    return Response.json({ trace });
  }

  const withFeedbackOnly = searchParams.get('withFeedbackOnly') === 'true';
  const summaries = store.listSummaries({ participantId: user.uid, withFeedbackOnly });
  return Response.json({ summaries, count: summaries.length });
}

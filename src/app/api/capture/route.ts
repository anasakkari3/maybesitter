import { analyticsContextFrom } from '../../../../lib/analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../../../lib/analytics/eventStore';
import { recordCaptureAnalytics } from '../../../../lib/analytics/loopAnalytics';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../lib/auth/mobileAuth';
import { CaptureInputTooLargeError } from '../../../../lib/services/captureBoundary/captureBoundaryService';
import { captureText } from '../../../../lib/services/captureService';
import { getCommandServiceState } from '../../../../lib/services/commandService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  /*
   * This is the legacy web surface, not the product — the middleware 404s it
   * on Cloud Run — but off Cloud Run it answers, so it runs the same guard
   * every mobile route runs (#511). First, before the body is read: the uid
   * out of the verified token is the only identity this route has.
   */
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: {
    text?: unknown;
    sessionId?: string;
    userId?: string;
    conversationId?: string;
    pendingClarificationId?: string;
    anonymousUserId?: string;
    consent?: string;
    locale?: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { text, sessionId, conversationId, pendingClarificationId } = body;
  const analytics = await analyticsContextFrom(body, appendAnalyticsEvent);
  const before = analytics ? getCommandServiceState() : null;

  try {
    const result = await captureText(text, {
      sessionId,
      // The uid is the scope, and the body never is: a `userId` field here is
      // the claim the guard above exists to ignore, the same rule the mobile
      // routes follow.
      userId: user.uid,
      conversationId,
      pendingClarificationId,
    });

    if (analytics && before) {
      await recordCaptureAnalytics(analytics, {
        inputLength: typeof text === 'string' ? text.length : 0,
        locale: body.locale === 'ar' || body.locale === 'he' ? body.locale : 'en',
        detectionSource: result.meta.engineUsed,
        before,
        after: getCommandServiceState(),
      });
    }

    return Response.json(result);
  } catch (error) {
    // The same refusal the mobile route answers with (#508): the status, the
    // reason code and the limit are one vocabulary across both capture doors.
    if (error instanceof CaptureInputTooLargeError) {
      return Response.json(
        { success: false, error: error.message, reason: 'text_too_long', maxCharacters: error.maxCharacters },
        { status: 413 },
      );
    }
    throw error;
  }
}

import { analyticsContextFrom } from '../../../../lib/analytics/analyticsContext';
import { appendAnalyticsEvent } from '../../../../lib/analytics/eventStore';
import { recordCaptureAnalytics } from '../../../../lib/analytics/loopAnalytics';
import { captureText } from '../../../../lib/services/captureService';
import { getCommandServiceState } from '../../../../lib/services/commandService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
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

  const { text, sessionId, userId, conversationId, pendingClarificationId } = body;
  const analytics = analyticsContextFrom(body, appendAnalyticsEvent);
  const before = analytics ? getCommandServiceState() : null;

  const result = await captureText(text, {
    sessionId,
    userId,
    conversationId,
    pendingClarificationId,
  });

  if (analytics && before) {
    recordCaptureAnalytics(analytics, {
      inputLength: typeof text === 'string' ? text.length : 0,
      locale: body.locale === 'ar' || body.locale === 'he' ? body.locale : 'en',
      detectionSource: result.meta.engineUsed,
      before,
      after: getCommandServiceState(),
    });
  }

  return Response.json(result);
}

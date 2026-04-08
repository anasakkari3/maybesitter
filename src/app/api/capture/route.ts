import { captureText } from '../../../../lib/services/captureService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: {
    text?: unknown;
    sessionId?: string;
    userId?: string;
    conversationId?: string;
    pendingClarificationId?: string;
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { text, sessionId, userId, conversationId, pendingClarificationId } = body;
  return Response.json(await captureText(text, {
    sessionId,
    userId,
    conversationId,
    pendingClarificationId,
  }));
}

import { recordPressureDelivery } from '../../../../../lib/services/pressureService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: {
    commitmentId?: unknown;
    sessionId?: string;
    userId?: string;
    conversationId?: string;
    message?: unknown;
    strategy?: unknown;
    path?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: 'Invalid request body' }, { status: 400 });
  }

  return Response.json(recordPressureDelivery(body.commitmentId, {
    sessionId: body.sessionId,
    userId: body.userId,
    conversationId: body.conversationId,
    surfacedMessage: body.message,
    surfacedStrategy: body.strategy,
    surfacedPath: body.path,
  }));
}

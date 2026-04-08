import { applyAgendaAction } from '../../../../../lib/services/agendaActionService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: {
    id?: unknown;
    action?: unknown;
    sessionId?: string;
    userId?: string;
    conversationId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, message: 'Invalid request body' }, { status: 400 });
  }

  return Response.json(applyAgendaAction(String(body.id || ''), body.action, new Date(), {
    sessionId: body.sessionId,
    userId: body.userId,
    conversationId: body.conversationId,
  }));
}

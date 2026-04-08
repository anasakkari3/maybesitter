import { getDailyAgenda } from '../../../../lib/services/agendaService';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  return Response.json({
    success: true,
    ...getDailyAgenda({
      sessionId: searchParams.get('sessionId') || undefined,
      userId: searchParams.get('userId') || undefined,
      conversationId: searchParams.get('conversationId') || undefined,
    }),
  });
}

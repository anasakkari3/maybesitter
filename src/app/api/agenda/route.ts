import { getDailyAgenda } from '../../../../lib/services/agendaService';
import { readEscalationCeiling } from '../../../../lib/services/mobile/reminderSettingsService';
import type { PressureCeiling } from '../../../../lib/services/pressureService';

export const dynamic = 'force-dynamic';

/**
 * The ceiling the account stored, or nothing — which the pressure path reads
 * as the gentlest ceiling (#199, #446). A request with no `userId`, a malformed
 * one, or a storage failure must not fail the agenda: it simply means no
 * ceiling is passed, which is the safe direction.
 */
async function storedCeilingFor(userId: string | undefined): Promise<PressureCeiling | undefined> {
  if (!userId) return undefined;
  try {
    return await readEscalationCeiling(userId);
  } catch {
    return undefined;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get('userId') || undefined;
  return Response.json({
    success: true,
    ...(await getDailyAgenda({
      sessionId: searchParams.get('sessionId') || undefined,
      userId,
      conversationId: searchParams.get('conversationId') || undefined,
      escalationCeiling: await storedCeilingFor(userId),
    })),
  });
}

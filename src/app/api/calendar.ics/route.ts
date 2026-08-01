import { buildCalendarFeed } from '../../../../lib/services/calendarFeedService';
import { getUnifiedAppSnapshot } from '../../../../lib/services/domainAppSnapshotAdapter';
import { resolvePilotAccess } from '../../../../lib/pilot/pilotAccess';
import { readRuntimeControls } from '../../../contracts/v1/runtimeControls';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const controls = readRuntimeControls();
  const pilotConfigured = process.env.MAYBESITTER_CLOSED_PILOT_IDS !== undefined || controls.featureFlags.recommendation;
  if (pilotConfigured) {
    try {
      const participantId = new URL(request.url).searchParams.get('participantId') || '';
      const access = resolvePilotAccess(participantId, new Date().toISOString());
      if (!access.decision.allowed || !access.trust?.calendarConsent) {
        return Response.json({ error: 'calendar access requires an authorized pilot participant and calendar consent' }, { status: 403 });
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'closed pilot is not configured' }, { status: 503 });
    }
  }
  const feed = buildCalendarFeed(await getUnifiedAppSnapshot());

  return new Response(feed, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="maybesitter.ics"',
      'Cache-Control': 'no-store',
    },
  });
}

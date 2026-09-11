import { buildCalendarFeed } from '../../../../lib/services/calendarFeedService';
import { getUnifiedAppSnapshot } from '../../../../lib/services/domainAppSnapshotAdapter';
import { resolveUserAccess } from '../../../../lib/pilot/pilotAccess';
import { readRuntimeControls } from '../../../contracts/v1/runtimeControls';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const controls = readRuntimeControls();
  // This was gated on the closed-pilot roster variable OR the feature flag;
  // that variable is gone (UC-1.0e, #144) and the flag is the whole gate.
  // This route is unreachable in production regardless: `src/middleware.ts`
  // answers 404 for everything outside `/api/mobile`, `/api/health` and
  // `/api/internal` on Cloud Run, and this one still trusts a URL parameter.
  if (controls.featureFlags.recommendation) {
    try {
      const participantId = new URL(request.url).searchParams.get('participantId') || '';
      const access = await resolveUserAccess(participantId, new Date().toISOString());
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

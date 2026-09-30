import { authorizeSchedulerRequest, schedulerAuthErrorResponse } from '../../../../../../lib/auth/schedulerOidc';
import { runGmailMonitorTick } from '../../../../../../lib/intelligence/gmailMonitor';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await authorizeSchedulerRequest(request);
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  try { return Response.json(await runGmailMonitorTick()); }
  catch { return Response.json({ error: 'intelligence_gmail_failed' }, { status: 500 }); }
}

import { authorizeSchedulerRequest, schedulerAuthErrorResponse } from '../../../../../../lib/auth/schedulerOidc';
import { runGmailJobTickForTests } from '../../../../../../lib/intelligence/gmailJobs';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await authorizeSchedulerRequest(request);
  if (!auth.ok) return schedulerAuthErrorResponse(auth);
  return Response.json(await runGmailJobTickForTests('sweep'));
}

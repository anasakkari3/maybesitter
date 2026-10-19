import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { resolveM5aCapabilities } from '../../../../../../lib/release/m5aControls';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try { await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  const resolved = await resolveM5aCapabilities();
  return Response.json({ success: true, calendarChoice: resolved.calendarChoice, emailSources: resolved.emailSources });
}

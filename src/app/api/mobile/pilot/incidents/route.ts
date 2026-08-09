import { mobilePilotErrorResponse, reportMobilePilotIncident } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../lib/services/mobile/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    return Response.json(reportMobilePilotIncident(auth.participantId, body), { status: 201 });
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

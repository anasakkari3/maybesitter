import { mobilePilotErrorResponse, reportMobilePilotIncident } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
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
    // The reporter is the authenticated user. A `participantId` in the body is
    // ignored rather than refused: it is not read at all.
    return Response.json(await reportMobilePilotIncident(user.uid, body), { status: 201 });
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

import { getMobileNextStep, mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../lib/services/mobile/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  try {
    return Response.json(await getMobileNextStep(auth.participantId, Object.fromEntries(searchParams.entries())));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

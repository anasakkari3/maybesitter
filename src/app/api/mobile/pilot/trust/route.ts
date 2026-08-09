import {
  getMobilePilotTrust,
  mobilePilotErrorResponse,
  updateMobilePilotTrust,
} from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobilePilotAuth } from '../../../../../../lib/services/mobile/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let auth;
  try {
    auth = requireMobilePilotAuth(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    return Response.json(await getMobilePilotTrust(auth.participantId));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

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
    return Response.json(await updateMobilePilotTrust(auth.participantId, body));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

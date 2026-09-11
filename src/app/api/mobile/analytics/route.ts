import {
  mobilePilotErrorResponse,
  recordMobilePilotLoopEvent,
} from '../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';

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
    return Response.json(await recordMobilePilotLoopEvent(user.uid, body));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

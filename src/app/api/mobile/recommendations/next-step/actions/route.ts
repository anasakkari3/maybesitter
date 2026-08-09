import { mobilePilotErrorResponse, recordMobileNextStepDecision } from '../../../../../../../lib/services/mobile/pilotService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    return Response.json(recordMobileNextStepDecision(body));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

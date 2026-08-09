import { mobilePilotErrorResponse, reportMobilePilotIncident } from '../../../../../../lib/services/mobile/pilotService';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    return Response.json(reportMobilePilotIncident(body), { status: 201 });
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

import { getMobileNextStep, mobilePilotErrorResponse } from '../../../../../../lib/services/mobile/pilotService';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    return Response.json(getMobileNextStep(Object.fromEntries(searchParams.entries())));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

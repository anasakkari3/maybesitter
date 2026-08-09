import {
  getMobilePilotTrust,
  mobilePilotErrorResponse,
  updateMobilePilotTrust,
} from '../../../../../../lib/services/mobile/pilotService';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    return Response.json(getMobilePilotTrust(Object.fromEntries(searchParams.entries())));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    return Response.json(await updateMobilePilotTrust(body));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

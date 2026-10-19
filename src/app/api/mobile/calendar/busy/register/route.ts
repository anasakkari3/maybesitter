import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { CalendarChoiceError, registerDeviceSource } from '../../../../../../../lib/calendar/calendarChoice';
import { readJsonBody } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const sourceId = await registerDeviceSource(user.uid, {
      sourceInstallationId: body.sourceInstallationId,
      sourceSecret: body.sourceSecret,
      registrationId: body.registrationId,
    });
    return Response.json({ success: true, sourceId });
  } catch (error) {
    if (error instanceof CalendarChoiceError) {
      const status = error.code === 'source_secret_invalid' ? 403 : error.code === 'invalid_request' ? 400 : 409;
      return Response.json({ success: false, error: error.code }, { status });
    }
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
}

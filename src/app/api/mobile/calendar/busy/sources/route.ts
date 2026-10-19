import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { CalendarChoiceError, listRegisteredDeviceSources } from '../../../../../../../lib/calendar/calendarChoice';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  try { return Response.json({ success: true, sources: await listRegisteredDeviceSources(user.uid) }); }
  catch (error) {
    if (error instanceof CalendarChoiceError) return Response.json({ success: false, error: error.code }, { status: 404 });
    throw error;
  }
}

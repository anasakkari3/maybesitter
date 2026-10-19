import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { calendarChoiceProbe, CalendarChoiceError, enrollCalendarChoice } from '../../../../../../lib/calendar/calendarChoice';

export const dynamic = 'force-dynamic';

function errorResponse(error: unknown): Response {
  if (error instanceof CalendarChoiceError) {
    const status = error.code === 'calendar_choice_unavailable' ? 404 : 409;
    return Response.json({ success: false, error: error.code }, { status });
  }
  throw error;
}

export async function GET(request: Request) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  const probe = await calendarChoiceProbe(user.uid, new URL(request.url).searchParams.get('sourceId'));
  return Response.json({ success: true, ...probe });
}

export async function POST(request: Request) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  try {
    const state = await enrollCalendarChoice(user.uid);
    return Response.json({ success: true, state: state.state, enrolledAt: state.enrolledAt });
  } catch (error) { return errorResponse(error); }
}

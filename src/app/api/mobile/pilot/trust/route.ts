import {
  getMobilePilotTrust,
  mobilePilotErrorResponse,
  updateMobilePilotTrust,
} from '../../../../../../lib/services/mobile/pilotService';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';
import { readCalendarChoice } from '../../../../../../lib/calendar/calendarChoice';

export const dynamic = 'force-dynamic';

async function projectCalendarChoice(uid: string, request: Request, response: Awaited<ReturnType<typeof getMobilePilotTrust>>) {
  if (request.headers.get('x-maybesitter-calendar-choice') === '1' || !(await readCalendarChoice(uid))) return response;
  return {
    ...response,
    trust: { ...response.trust, calendarConsent: false },
    whatKnows: { ...response.whatKnows, calendarConnected: false },
  };
}

export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  try {
    return Response.json(await projectCalendarChoice(user.uid, request, await getMobilePilotTrust(user.uid)));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

/**
 * `forceRevocationCheck` on purpose: this is the route a `revoke` or `delete`
 * action arrives on, and the 60 s revocation cache is not good enough for the
 * destructive paths. The action is only knowable after the body is read, and
 * the body must not be read before the caller is authenticated, so the whole
 * write route pays the extra `getUser` rather than guessing. It is a
 * low-volume endpoint; correctness is worth the round trip.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request, { forceRevocationCheck: true });
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobilePilotErrorResponse(new Error('Invalid JSON request body'));
  }

  try {
    const response = await updateMobilePilotTrust(user.uid, body);
    return Response.json(await projectCalendarChoice(user.uid, request, response));
  } catch (error) {
    return mobilePilotErrorResponse(error);
  }
}

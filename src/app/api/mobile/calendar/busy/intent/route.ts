import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../../lib/account/accountLiveness';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { CalendarChoiceError, SOURCE_SECRET_HEADER, startSelectionIntent } from '../../../../../../../lib/calendar/calendarChoice';
import { BusyUploadError } from '../../../../../../../lib/calendar/busyBlocks';
import { readJsonBody } from '../../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  let user;
  try { user = await requireMobileUser(request); }
  catch (error) { return mobileAuthErrorResponse(error); }
  try {
    const body = await readJsonBody<Record<string, unknown>>(request);
    const result = await startSelectionIntent(user.uid, {
      sourceId: body.sourceId, intentId: body.intentId, operation: body.operation,
      selectionDigest: body.selectionDigest, choiceVersion: body.choiceVersion,
    }, request.headers.get(SOURCE_SECRET_HEADER) ?? '');
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    if (error instanceof CalendarChoiceError) {
      const status = error.code === 'source_secret_invalid' ? 403 : error.code === 'invalid_request' ? 400 : 409;
      return Response.json({ success: false, error: error.code, ...(error.currentEpoch === undefined ? {} : { currentEpoch: error.currentEpoch }) }, { status });
    }
    if (error instanceof BusyUploadError) return Response.json({ success: false, error: 'source_forbidden' }, { status: 400 });
    return Response.json({ success: false, error: 'invalid_request' }, { status: 400 });
  }
}

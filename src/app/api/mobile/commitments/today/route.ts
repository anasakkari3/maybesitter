import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { listToday } from '../../../../../../lib/services/mobile/commitmentService';
import { commitmentListResponse } from '../../../../../../lib/services/mobile/response';
import { dateFromOptionalIso } from '../../../../../../lib/services/mobile/time';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  return Response.json(commitmentListResponse(await listToday({
    now: dateFromOptionalIso(searchParams.get('referenceTime'), new Date(), 'referenceTime'),
    timezone: searchParams.get('timezone') ?? undefined,
    participantId: user.uid,
  })));
}

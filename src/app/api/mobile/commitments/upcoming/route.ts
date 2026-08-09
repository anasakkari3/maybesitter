import { listUpcoming } from '../../../../../../lib/services/mobile/commitmentService';
import { commitmentListResponse } from '../../../../../../lib/services/mobile/response';
import { dateFromOptionalIso } from '../../../../../../lib/services/mobile/time';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  return Response.json(commitmentListResponse(listUpcoming({
    now: dateFromOptionalIso(searchParams.get('referenceTime'), new Date(), 'referenceTime'),
    timezone: searchParams.get('timezone') ?? undefined,
  })));
}

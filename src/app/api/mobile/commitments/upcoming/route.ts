import { listUpcoming } from '../../../../../../lib/services/mobile/commitmentService';
import { commitmentListResponse } from '../../../../../../lib/services/mobile/response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  return Response.json(commitmentListResponse(listUpcoming({
    timezone: searchParams.get('timezone') ?? undefined,
  })));
}

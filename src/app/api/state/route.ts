import { getUnifiedAppSnapshot } from '../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(await getUnifiedAppSnapshot());
}

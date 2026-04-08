import type { DailyDigest } from '@/types';
import { confirmDailyDigestAndAcknowledgeDueItems } from '../../../../../lib/services/appMetadataService';
import { getUnifiedAppSnapshot } from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let body: { digest?: DailyDigest; today?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body');
  }

  if (!body.digest) {
    return jsonError('digest is required');
  }

  try {
    await confirmDailyDigestAndAcknowledgeDueItems(body.digest, body.today);
    return Response.json(await getUnifiedAppSnapshot());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Action failed');
  }
}

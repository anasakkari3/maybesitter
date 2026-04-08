import {
  createCommitmentFromItem,
  getUnifiedAppSnapshot,
} from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body');
  }
  try {
    createCommitmentFromItem(body.item as Record<string, unknown> ?? body);
    return Response.json(await getUnifiedAppSnapshot());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Could not create commitment');
  }
}

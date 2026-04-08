import {
  updateCommitmentFromItem,
  getUnifiedAppSnapshot,
} from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { updates?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body');
  }
  try {
    updateCommitmentFromItem(id, (body.updates ?? body) as Record<string, unknown>);
    return Response.json(await getUnifiedAppSnapshot());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Could not update commitment');
  }
}

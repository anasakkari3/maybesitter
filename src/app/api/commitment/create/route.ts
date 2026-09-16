import {
  collisionsFor,
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
    const commitmentId = createCommitmentFromItem(body.item as Record<string, unknown> ?? body);
    const snapshot = await getUnifiedAppSnapshot();
    // Adds a field, never changes one (#football-fixtures task 10): an older
    // client that does not know about `collisions` keeps reading the same
    // snapshot it always did.
    return Response.json({ ...snapshot, collisions: collisionsFor(commitmentId) });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Could not create commitment');
  }
}

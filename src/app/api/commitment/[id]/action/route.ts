import {
  applyLegacyItemAction,
  getUnifiedAppSnapshot,
} from '../../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

const KNOWN_ACTIONS = new Set(['acknowledge', 'complete', 'cancel']);

function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON request body');
  }
  const { action } = body;
  if (!action || !KNOWN_ACTIONS.has(action)) {
    return jsonError(`Unknown commitment action: ${action}`);
  }
  try {
    const legacyAction = action === 'acknowledge' ? 'aware' : (action as 'complete' | 'cancel');
    applyLegacyItemAction(id, legacyAction);
    return Response.json(await getUnifiedAppSnapshot());
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Action failed');
  }
}

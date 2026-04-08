import {
  clearCommitments,
  getUnifiedAppSnapshot,
} from '../../../../../lib/services/domainAppSnapshotAdapter';

export const dynamic = 'force-dynamic';

export async function POST() {
  clearCommitments();
  return Response.json(await getUnifiedAppSnapshot());
}

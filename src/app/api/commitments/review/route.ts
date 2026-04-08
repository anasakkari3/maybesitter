import { getCommitmentReviewSnapshot } from '../../../../../lib/services/commitmentReviewService';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(getCommitmentReviewSnapshot());
}

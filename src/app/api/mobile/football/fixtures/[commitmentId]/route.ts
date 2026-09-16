import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { dismissFixtureCommitment } from '../../../../../../../lib/football/projectFixtures';

export const dynamic = 'force-dynamic';

/**
 * The opt-out the design rests on: "I love Barcelona" gets every match
 * projected, and this is how one of them gets taken back off a calendar
 * without unfollowing the whole club (football fixtures MVP, Task 11).
 *
 * ── Why an unlinked commitment is 404, not a no-op 200 ────────────────────
 * `dismissFixtureCommitment` throws when no `ExternalTaskReference` in *this
 * user's own tree* names `commitmentId` as its `linkedCommitmentId` -- true
 * both for an id nobody has ever heard of and for a real, user-typed
 * commitment this projection never touched. Both cases are answered
 * identically: this route has nothing to dismiss, and a probe against
 * somebody else's commitment id, or a client bug that lets the dismiss
 * button reach a non-fixture row, learns nothing more from the 404 than
 * that. See `lib/football/projectFixtures.ts`'s `dismissFixtureCommitment`
 * and the module header's "Why `Commitment` carries no `origin` field" for
 * why this is a join against the ref store rather than a field read.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ commitmentId: string }> },
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { commitmentId } = await params;
  const now = new Date().toISOString();

  try {
    await dismissFixtureCommitment(user.uid, commitmentId, now);
  } catch {
    return mobileError('no football fixture links this commitment', 404);
  }

  return Response.json({ success: true, id: commitmentId, dismissed: true });
}

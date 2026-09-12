import { deleteAccount, subjectHashFor, subjectTag } from '../../../../../lib/account/accountDeletion';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../lib/auth/mobileAuth';

export const dynamic = 'force-dynamic';

/** The exact string the client must send. Not a checkbox the UI can default. */
const CONFIRMATION = 'delete-my-account';

/**
 * How recently the session must have actually authenticated (UC-1.5, #149).
 *
 * Five minutes. Deleting an account is the one action where a phone left
 * unlocked on a table should not be enough: the person doing it has to have
 * proved who they are just now, not whenever they first signed in.
 */
const RECENT_LOGIN_WINDOW_S = 300;

export async function DELETE(request: Request) {
  let user;
  try {
    // `forceRevocationCheck`: this path must not run on a session that was
    // revoked in the last minute, so it reads revocation state now rather than
    // off the cache.
    user = await requireMobileUser(request, { forceRevocationCheck: true });
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - user.authTime;
  if (ageSeconds > RECENT_LOGIN_WINDOW_S) {
    // The client's job is to re-authenticate and try again, which is why this
    // says which of the many reasons for a 401 it is.
    return Response.json(
      { success: false, error: 'recent login required', reason: 'recent_login_required' },
      { status: 401 },
    );
  }

  let body: { confirmation?: unknown };
  try {
    body = await request.json() as { confirmation?: unknown };
  } catch {
    return Response.json({ success: false, error: 'Invalid JSON request body' }, { status: 400 });
  }
  if (body?.confirmation !== CONFIRMATION) {
    return Response.json(
      { success: false, error: 'confirmation required', reason: 'confirmation_required' },
      { status: 400 },
    );
  }

  // The uid comes from the verified token and from nowhere else: a body field
  // naming someone to delete would be the worst possible thing to trust.
  const receipt = await deleteAccount(user.uid, { initiatedBy: 'user' });
  // Only these two. A log line that named the account would outlive it.
  console.info(`[account/delete] receipt=${receipt.receiptId} subject=${subjectTag(subjectHashFor(user.uid))}`);

  return Response.json({
    success: true,
    receipt: {
      receiptId: receipt.receiptId,
      deletedAt: receipt.deletedAt,
      steps: receipt.steps,
    },
  });
}

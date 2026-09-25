import { ExportTooLargeError, MAX_EXPORTS_PER_DAY, buildAccountExport } from '../../../../../../lib/account/accountExport';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { reserveDailyAction } from '../../../../../../lib/llm/usageGuard';

export const dynamic = 'force-dynamic';

/**
 * "Export my data" (#174 step 7): one JSON document of everything this account
 * holds, from the same collection list account deletion uses
 * (`lib/account/accountExport.ts`).
 *
 * `forceRevocationCheck`, as deletion does: a copy of somebody's whole account
 * must not go to a session that was revoked in the last minute.
 *
 * Nothing is logged — not the uid, not a count. The body is the person's
 * content, and a log line about it is a second copy of it.
 */
export async function GET(request: Request): Promise<Response> {
  let user;
  try {
    user = await requireMobileUser(request, { forceRevocationCheck: true });
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  // Fails closed: a counter that cannot be read refuses rather than waves the
  // export through, as every other daily action does.
  const reservation = await reserveDailyAction(user.uid, 'account_export', MAX_EXPORTS_PER_DAY);
  if (reservation !== 'ok') {
    return Response.json(
      {
        success: false,
        error: 'too many exports today',
        reason: 'export_rate_limited',
        maxPerDay: MAX_EXPORTS_PER_DAY,
      },
      { status: 429, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  try {
    // The uid comes from the verified token and from nowhere else.
    const exported = await buildAccountExport(user.uid);
    return Response.json(exported, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ExportTooLargeError) {
      return Response.json(
        { success: false, error: 'export too large', reason: 'export_too_large' },
        { status: 413, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      { success: false, error: 'could not export the account', reason: 'export_failed' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

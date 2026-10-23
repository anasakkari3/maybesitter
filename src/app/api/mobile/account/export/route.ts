import {
  ExportReservationError,
  ExportTooLargeError,
  ExportUnavailableError,
  MAX_EXPORTS_PER_DAY,
  buildAccountExport,
  commitAccountExport,
  releaseAccountExport,
  reserveAccountExport,
} from '../../../../../../lib/account/accountExport';
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { getStorage } from '../../../../../../lib/storage';

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
  const storage = getStorage();
  const at = new Date().toISOString();
  let reservation;
  try { reservation = await reserveAccountExport(user.uid, at, storage); }
  catch { reservation = null; }
  if (!reservation) {
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
    const exported = await buildAccountExport(user.uid, { storage, now: new Date(at) });
    await commitAccountExport(user.uid, reservation, new Date().toISOString(), storage);
    return Response.json(exported, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ExportTooLargeError) {
      try {
        await commitAccountExport(user.uid, reservation, new Date().toISOString(), storage);
      } catch (settlementError) {
        await releaseAccountExport(reservation, storage).catch(() => undefined);
        if (settlementError instanceof ExportReservationError) {
          return Response.json(
            { success: false, error: 'could not export the account', reason: 'export_retryable' },
            { status: 503, headers: { 'Cache-Control': 'no-store' } },
          );
        }
        return Response.json(
          { success: false, error: 'could not export the account', reason: 'export_failed' },
          { status: 500, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      return Response.json(
        { success: false, error: 'export too large', reason: 'export_too_large' },
        { status: 413, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    await releaseAccountExport(reservation, storage).catch(() => undefined);
    if (error instanceof ExportUnavailableError || error instanceof ExportReservationError) {
      return Response.json(
        { success: false, error: 'could not export the account', reason: 'export_retryable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      { success: false, error: 'could not export the account', reason: 'export_failed' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

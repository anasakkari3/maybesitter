import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import {
  HISTORY_MAX_LIMIT,
  listBackgroundActivityHistory,
} from '../../../../../../../lib/watchers/backgroundActivityHistory';
import {
  isBackgroundMonitorHistoryKind,
  type BackgroundMonitorHistoryKind,
} from '../../../../../../../src/contracts/v1/backgroundMonitorContracts';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/mobile/trust/background-activity/history` (#527).
 *
 * User-visible history of background monitoring activity for the signed-in account:
 * - watcher condition changed;
 * - notification sent;
 * - plan reconsidered.
 * No raw provider payloads.
 *
 * Bounded (default 50, max 200), newest first.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { searchParams } = new URL(request.url);
  const rawLimit = searchParams.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > HISTORY_MAX_LIMIT) {
      return mobileError(`limit must be an integer between 1 and ${HISTORY_MAX_LIMIT}`);
    }
    limit = parsed;
  }

  const watcherId = searchParams.get('watcherId') ?? searchParams.get('monitorId') ?? undefined;

  const rawKind = searchParams.get('kind');
  let kind: BackgroundMonitorHistoryKind | undefined;
  if (rawKind !== null) {
    if (!isBackgroundMonitorHistoryKind(rawKind)) {
      return mobileError('invalid history kind');
    }
    kind = rawKind;
  }

  try {
    const historyView = await listBackgroundActivityHistory(user.uid, {
      limit,
      watcherId,
      kind,
    });
    return Response.json({ success: true, ...historyView });
  } catch (error) {
    console.error('[trust] listing background activity history failed', error);
    return mobileError('could not read your background monitoring history', 500);
  }
}

import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { acceptLectureSessionsAsBusyBlocks, manualBusySourceId } from '../../../../../../lib/calendar/manualBusy';
import { deleteBusySource, BusyUploadError } from '../../../../../../lib/calendar/busyBlocks';
import type { ShareRecurringSession } from '../../../../../../lib/services/share/shareTypes';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/**
 * Accepts recurring lecture sessions as manual busy blocks (UC-3.7, #191 Step 7).
 *
 * Expands sessions for 16 weeks into `users/{uid}/calendarSources/manual-{proposalId}`.
 * Never creates commitments.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return mobileError('the request body must be an object');
  }

  const b = body as Record<string, unknown>;
  const proposalId = typeof b.proposalId === 'string' ? b.proposalId.trim() : '';
  if (!proposalId) {
    return mobileError('proposalId is required');
  }

  if (!Array.isArray(b.sessions)) {
    return mobileError('sessions must be an array');
  }

  const sessions: ShareRecurringSession[] = [];
  for (const s of b.sessions) {
    if (typeof s !== 'object' || s === null) {
      return mobileError('each session must be an object');
    }
    const raw = s as Record<string, unknown>;
    const weekday = Number(raw.weekday);
    const start = typeof raw.start === 'string' ? raw.start.trim() : '';
    const end = typeof raw.end === 'string' ? raw.end.trim() : '';
    const label = typeof raw.label === 'string' ? raw.label.trim() : null;

    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return mobileError('weekday must be an integer between 0 and 6');
    }
    if (!start || !end) {
      return mobileError('start and end times are required');
    }
    sessions.push({ weekday, start, end, label });
  }

  const timezone = typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : undefined;
  const referenceTime = typeof b.referenceTime === 'string' && b.referenceTime.trim() ? b.referenceTime.trim() : undefined;

  try {
    const outcome = await acceptLectureSessionsAsBusyBlocks(user.uid, proposalId, sessions, {
      timezone: timezone ?? 'Asia/Jerusalem',
      referenceTime,
    });

    return Response.json({
      success: true,
      sourceId: outcome.sourceId,
      blocks: outcome.written,
      windowStart: outcome.window.startsAt,
      windowEnd: outcome.window.endsAt,
    });
  } catch (error) {
    return mobileError(error instanceof Error ? error.message : 'Failed to store manual busy blocks');
  }
}

/**
 * Disconnect/delete a manual busy source.
 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const url = new URL(request.url);
  const proposalId = url.searchParams.get('proposalId');
  const sourceIdParam = url.searchParams.get('sourceId');

  const sourceId = sourceIdParam ?? (proposalId ? manualBusySourceId(proposalId) : null);
  if (!sourceId || !sourceId.trim()) {
    return mobileError('sourceId or proposalId is required');
  }

  try {
    const result = await deleteBusySource(user.uid, sourceId.trim());
    return Response.json({ success: true, deleted: result.deleted });
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }
}

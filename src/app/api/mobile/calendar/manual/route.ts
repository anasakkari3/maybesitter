import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import {
  acceptLectureSessionsAsBusyBlocks,
  deleteManualBusySource,
  listManualBusySources,
  manualBusySourceId,
  ManualBusyLimitError,
} from '../../../../../../lib/calendar/manualBusy';
import { AccountUnavailableError, accountUnavailableResponse } from '../../../../../../lib/account/accountLiveness';
import { CalendarConsentChangedError, readCalendarConsentStamp } from '../../../../../../lib/calendar/calendarConsentFence';
import { getStorage } from '../../../../../../lib/storage';
import { deleteBusySource, BusyUploadError, sourceKindOf } from '../../../../../../lib/calendar/busyBlocks';
import type { ShareRecurringSession } from '../../../../../../lib/services/share/shareTypes';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

function consentRequired(): Response {
  return Response.json(
    {
      success: false,
      error: 'calendar busy time is only stored once you turn the calendar on',
      reason: 'calendar_consent_required',
    },
    { status: 403 },
  );
}

const EXACT_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function validSessionTime(start: string, end: string): boolean {
  if (!EXACT_TIME.test(start) || !EXACT_TIME.test(end)) return false;
  const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  return minutes(end) > minutes(start);
}

/**
 * What the person added by hand (QA audit CXA10.3): the app lists these so
 * each one can be removed. No session labels are stored, so none are served.
 */
export async function GET(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }
  return Response.json({ success: true, sources: await listManualBusySources(user.uid) });
}

/**
 * Accepts recurring lecture sessions as manual busy blocks (UC-3.7, #191 Step 7).
 *
 * Expands sessions for 16 weeks into `users/{uid}/calendarSources/manual-{proposalId}`.
 * Never creates commitments.
 *
 * Manual busy time is calendar data, so it is kept only under calendar
 * consent, exactly as `POST /calendar/busy` (QA audit CA10.4). One request
 * carries at most MANUAL_SESSION_LIMIT sessions, and an account holds at most
 * MANUAL_SOURCE_LIMIT sources (#749); both refusals carry a `reason`.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  // As `icsFeeds.accountRefusal`: consent on, and the account neither revoked
  // nor deleted. The stamp is re-checked inside every write (review 2 of B8).
  const consent = await readCalendarConsentStamp(getStorage(), user.uid);
  if (!consent) return consentRequired();

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
    if (!validSessionTime(start, end)) {
      return Response.json({ success: false, reason: 'invalid_session' }, { status: 400 });
    }
    sessions.push({ weekday, start, end, label });
  }

  const timezone = typeof b.timezone === 'string' && b.timezone.trim() ? b.timezone.trim() : undefined;
  const referenceTime = typeof b.referenceTime === 'string' && b.referenceTime.trim() ? b.referenceTime.trim() : undefined;

  try {
    const outcome = await acceptLectureSessionsAsBusyBlocks(user.uid, proposalId, sessions, {
      timezone: timezone ?? 'Asia/Jerusalem',
      referenceTime,
      consent,
    });

    return Response.json({
      success: true,
      sourceId: outcome.sourceId,
      blocks: outcome.written,
      windowStart: outcome.window.startsAt,
      windowEnd: outcome.window.endsAt,
    });
  } catch (error) {
    if (error instanceof AccountUnavailableError) return accountUnavailableResponse();
    if (error instanceof CalendarConsentChangedError) return consentRequired();
    if (error instanceof ManualBusyLimitError) {
      return Response.json(
        { success: false, reason: error.reason },
        { status: error.reason === 'manual_busy_limit' ? 409 : 400 },
      );
    }
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
  // A weekly block's occurrences go with the block (DELETE /weekly-blocks/{id}
  // or a pause). Removed here, the block would restate them at its next
  // renewal while the person believed them gone.
  try {
    if (sourceKindOf(sourceId.trim()) === 'weekly') {
      return mobileError('a weekly block is removed by deleting or pausing the block', 400);
    }
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }

  try {
    const id = sourceId.trim();
    const result = sourceKindOf(id) === 'manual'
      ? await deleteManualBusySource(user.uid, id)
      : await deleteBusySource(user.uid, id);
    return Response.json({ success: true, sourceId: id, deleted: result.deleted });
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }
}

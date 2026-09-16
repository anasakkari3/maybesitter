import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../../lib/services/mobile/response';
import { getCommitment } from '../../../../../../../lib/services/mobile/commitmentService';
import {
  DeviceCalendarLinkConflictError,
  DeviceCalendarLinkValidationError,
  deleteDeviceCalendarLink,
  putDeviceCalendarLink,
} from '../../../../../../../lib/services/calendar/deviceCalendarLinks';

export const dynamic = 'force-dynamic';

/**
 * Which event in the user's own calendar this commitment was written to
 * (UC-3.1, #185).
 *
 * ── The 409 is the duplicate-suppression rule ────────────────────
 *
 * Two devices on one account both hold the same confirmed commitment and both
 * would write an event. The first to `PUT` owns the link; every other writer is
 * answered 409 `calendar_link_owned_elsewhere` and writes nothing. A second 409,
 * `calendar_link_detached`, refuses to relink a commitment whose event the user
 * deleted in their Calendar app — see `deviceCalendarLinks.ts` for why that is a
 * tombstone rather than a state to recover from.
 *
 * ── Why a commitment that does not exist is a 404 ────────────────
 *
 * A link is about a commitment. Storing one for an id this account does not
 * have would let a caller write rows into somebody's tree under any id they
 * liked, and would leave the rows behind when the commitment they name never
 * arrives. Another user's commitment is simply not in this user's tree, so it
 * reads as 404 and a probe learns nothing from the difference.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  if (!(await getCommitment(id, { participantId: user.uid }))) {
    return mobileError('Commitment not found', 404);
  }

  try {
    const link = await putDeviceCalendarLink(
      user.uid,
      id,
      {
        writerId: body.writerId,
        calendarId: body.calendarId,
        eventId: body.eventId,
        contentHash: body.contentHash,
        state: body.state,
      },
      new Date(),
    );
    return Response.json({ success: true, id, deviceCalendarLink: link });
  } catch (error) {
    return linkErrorResponse(error, 'could not store the calendar link');
  }
}

/**
 * Forgets the link, which is what "Remove events MaybeSitter added" does once
 * the event itself is gone from the device.
 *
 * Only the owning installation may, so a device that cannot see the calendar
 * the event is in cannot free the row for a third one to duplicate into.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const { id } = await params;
  // The writer is in the query string rather than a body: a DELETE body is not
  // reliably carried by every intermediary, and this one decides whether the
  // request is allowed at all.
  const writerId = new URL(request.url).searchParams.get('writerId');

  try {
    const result = await deleteDeviceCalendarLink(user.uid, id, writerId);
    return Response.json({ success: true, id, deleted: result.deleted });
  } catch (error) {
    return linkErrorResponse(error, 'could not remove the calendar link');
  }
}

function linkErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof DeviceCalendarLinkConflictError) {
    return Response.json(
      {
        success: false,
        error: error.message,
        reason: error.reason === 'detached' ? 'calendar_link_detached' : 'calendar_link_owned_elsewhere',
      },
      { status: 409 },
    );
  }
  if (error instanceof DeviceCalendarLinkValidationError) return mobileError(error.message, 400);
  return mobileError(error instanceof Error ? error.message : fallback, 500);
}

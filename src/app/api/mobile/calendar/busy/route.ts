import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { readTrust } from '../../../../../../lib/pilot/pilotTrustStore';
import {
  BusyUploadError,
  deleteBusySource,
  parseBusyUpload,
  replaceBusyBlocks,
  type BusyBlock,
} from '../../../../../../lib/calendar/busyBlocks';

export const dynamic = 'force-dynamic';

/**
 * When somebody is busy, and nothing about what with (UC-3.2, #186).
 *
 * ── Why the consent check is here and not only on the phone ──────
 *
 * The app already refuses to sync until the Trust Center's calendar switch is
 * on, and that is the check that stops the bytes leaving the device — the one
 * that matters most, because data that never left cannot be held. This one
 * stops them being *kept*. A build with a bug, an old binary, or anything
 * holding a valid token can post a window; the server's answer to an account
 * that never said yes has to be a refusal rather than a row, or "we store your
 * busy time only if you asked us to" is a claim about a client rather than
 * about the service.
 *
 * `DELETE` deliberately does not check it. The person most likely to press
 * "Disconnect and delete" is the person who has just turned the switch off, and
 * a 403 there would strand their data on the server permanently.
 *
 * ── Why an extra key is a 400 ────────────────────────────────────
 *
 * `parseBusyUpload` refuses a block carrying `title`, `notes`, `location` or
 * anything else outside its allowlist, and this route reports that refusal
 * rather than storing the four fields it recognised. `expo-calendar` puts event
 * titles in the app's memory — the Flutter bridge never did — so the guarantee
 * that none of them reaches a server is now a property of code rather than of a
 * platform. A route that quietly dropped the extra key would keep the
 * guarantee and lose the ability to ever notice it had nearly been broken.
 */
export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const trust = await readTrust(user.uid);
  if (trust?.calendarConsent !== true) {
    return Response.json(
      {
        success: false,
        error: 'calendar busy time is only stored once you turn the calendar on',
        reason: 'calendar_consent_required',
      },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return mobileError('Invalid JSON request body');
  }

  let upload;
  try {
    upload = parseBusyUpload(body);
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }

  const blocks: BusyBlock[] = upload.blocks.map((block) => ({
    blockId: block.blockId,
    sourceId: upload.sourceId,
    sourceKind: upload.sourceKind,
    startAt: block.startAt,
    endAt: block.endAt,
    allDay: block.allDay,
  }));

  const now = new Date();
  await replaceBusyBlocks(user.uid, upload.sourceId, upload.window, blocks, {
    platform: upload.platform,
    now,
  });

  // The window and the time, and no count of anything the user could recognise.
  return Response.json({
    success: true,
    blocks: blocks.length,
    source: {
      sourceId: upload.sourceId,
      lastSyncedAt: now.toISOString(),
      windowStart: upload.window.startsAt,
      windowEnd: upload.window.endsAt,
    },
  });
}

/**
 * Disconnect and delete.
 *
 * The source is in the query string rather than a body for the reason the
 * device-calendar link route gives: a `DELETE` body is not reliably carried by
 * every intermediary, and this value decides what is removed. A request that
 * names no source is refused rather than treated as "all of them" — the wider
 * reading of a missing parameter is the one that cannot be undone.
 */
export async function DELETE(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  const sourceId = new URL(request.url).searchParams.get('sourceId');
  if (sourceId === null || sourceId.trim() === '') {
    return mobileError('sourceId is required', 400);
  }

  try {
    const result = await deleteBusySource(user.uid, sourceId);
    return Response.json({ success: true, deleted: result.deleted });
  } catch (error) {
    if (error instanceof BusyUploadError) return mobileError(error.message, 400);
    throw error;
  }
}

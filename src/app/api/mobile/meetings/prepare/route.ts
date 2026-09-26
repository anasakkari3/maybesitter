/**
 * `POST /api/mobile/meetings/prepare` — «حضّرني» (closure lane CL5a).
 *
 * The phone sends a busy block's times and the notes the person wrote about
 * it; this answers with an ordinary capture proposal — one prep step before
 * the meeting, and any follow-ups — which the phone reviews and confirms
 * through `/api/mobile/capture/confirm`. Nothing is saved here but the
 * proposal, which expires like every capture proposal.
 *
 * ── The order of the refusals is the design ──────────────────────
 *
 *  1. authentication, before a byte of the body is read;
 *  2. the body, counted while it streams and cancelled at 16 KiB (#659) —
 *     2,000 characters of notes is at most 8 KB, and nothing legitimate here
 *     is larger;
 *  3. the request's own checks: notes present and within the capture limit, a
 *     real block that has not started;
 *  4. the day's cap, last, so a request that was always going to be refused
 *     never spends one of the twenty.
 *
 * Consent is not a refusal. With AI consent off the service reads the notes
 * with rules and still proposes one prep step; with it on, the model call goes
 * through the gated, metered provider (per-call cost cap, call log with cost
 * attribution under `meeting_intelligence`).
 *
 * ── What is logged ───────────────────────────────────────────────
 *
 * An error's name, never its message and never the notes: a failure deeper
 * in the pipeline can quote the text it was reading.
 */
import { mobileAuthErrorResponse, requireMobileUser } from '../../../../../../lib/auth/mobileAuth';
import { reserveDailyAction, retryAfterSecondsFor } from '../../../../../../lib/llm/usageGuard';
import { CaptureInputTooLargeError } from '../../../../../../lib/services/captureBoundary/captureBoundaryService';
import {
  MAX_MEETING_PREPS_PER_DAY,
  MeetingPrepInputError,
  prepareMeeting,
  validateMeetingPrepInput,
  type MeetingPrepInput,
} from '../../../../../../lib/services/mobile/meetingPrepService';
import { mobileError } from '../../../../../../lib/services/mobile/response';
import { RequestBodyTooLargeError, readJsonBody, requestBodyTooLargeResponse } from '../../../../../../lib/net/requestBody';

export const dynamic = 'force-dynamic';

/** The most this route reads. See the header. */
const MEETING_PREP_BODY_LIMIT_BYTES = 16 * 1024;

function refused(error: MeetingPrepInputError): Response {
  return Response.json({ success: false, error: error.message, reason: error.reason }, { status: 400 });
}

function tooLong(error: CaptureInputTooLargeError): Response {
  return Response.json(
    { success: false, error: error.message, reason: 'text_too_long', maxCharacters: error.maxCharacters },
    { status: 413 },
  );
}

export async function POST(request: Request) {
  let user;
  try {
    user = await requireMobileUser(request);
  } catch (error) {
    return mobileAuthErrorResponse(error);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, { limitBytes: MEETING_PREP_BODY_LIMIT_BYTES });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return requestBodyTooLargeResponse(error);
    return mobileError('Invalid JSON request body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return mobileError('Invalid JSON request body');
  const input = body as MeetingPrepInput;

  const now = new Date();
  try {
    validateMeetingPrepInput(input, now);
  } catch (error) {
    if (error instanceof MeetingPrepInputError) return refused(error);
    if (error instanceof CaptureInputTooLargeError) return tooLong(error);
    throw error;
  }

  // Fails closed: an unreadable counter refuses rather than waves it through.
  const reservation = await reserveDailyAction(user.uid, 'meeting_prepare', MAX_MEETING_PREPS_PER_DAY, { now });
  if (reservation !== 'ok') {
    const retryAfterSeconds = retryAfterSecondsFor('user_daily', now);
    return Response.json(
      {
        success: false,
        error: 'too many meeting preps today',
        reason: 'meeting_prep_rate_limited',
        scope: 'user_daily',
        retryAfterSeconds,
        maxPerDay: MAX_MEETING_PREPS_PER_DAY,
      },
      { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
    );
  }

  try {
    const result = await prepareMeeting(user.uid, input, { now });
    return Response.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof MeetingPrepInputError) return refused(error);
    if (error instanceof CaptureInputTooLargeError) return tooLong(error);
    console.error(`[meetings/prepare] preparing failed: ${error instanceof Error ? error.name : 'unknown'}`);
    return mobileError('could not prepare this meeting', 500);
  }
}

/**
 * The one way a Google route turns a failure into a response (CL6a).
 *
 * Every refusal is a closed `reason`; no message from Google, from a model or
 * from the mail or file being read ever reaches a body. The share pipeline's
 * own refusals keep the exact bodies `/api/mobile/capture/share` gives them,
 * so the app's existing handling of a quota, an over-long text or an
 * unreadable file applies to a Gmail scan and a Drive import unchanged.
 */
import { CaptureInputTooLargeError } from '../../services/captureBoundary/captureBoundaryService';
import { ShareQuotaError } from '../../services/share/shareIntakeService';
import { ShareInputError, ShareTextTooLongError } from '../../services/share/shareTypes';
import { googleErrorResponse } from './googleConnectService';
import { GoogleCalendarConsentError } from './googleCalendarBusy';
import { DriveImportInputError } from './googleDrive';

export function invalidGoogleRequest(): Response {
  return Response.json({ success: false, error: 'invalid_request', reason: 'invalid_request' }, { status: 400 });
}

export function googleFailureResponse(error: unknown): Response {
  if (error instanceof GoogleCalendarConsentError) {
    return Response.json(
      { success: false, error: error.message, reason: 'calendar_consent_required' },
      { status: 403 },
    );
  }
  if (error instanceof DriveImportInputError) return invalidGoogleRequest();
  if (error instanceof CaptureInputTooLargeError || error instanceof ShareTextTooLongError) {
    return Response.json(
      { success: false, error: error.message, reason: 'text_too_long', maxCharacters: error.maxCharacters },
      { status: 413 },
    );
  }
  if (error instanceof ShareInputError) {
    return Response.json({ success: false, error: error.message, reason: error.reason }, { status: error.status });
  }
  if (error instanceof ShareQuotaError) {
    return Response.json(
      {
        success: false,
        error: error.message,
        reason: 'share_quota',
        scope: 'user_daily',
        retryAfterSeconds: error.retryAfterSeconds,
      },
      { status: 429, headers: { 'retry-after': String(error.retryAfterSeconds) } },
    );
  }
  return googleErrorResponse(error);
}

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
import { LLMUnavailableError } from '../../../src/extraction/llm';
import { retryAfterSecondsFor, type QuotaScope } from '../../llm/usageGuard';

const QUOTA_SCOPES: ReadonlySet<string> = new Set<QuotaScope>(['user_daily', 'user_minute', 'global_daily']);

/**
 * The model's own quota, when a read cannot go on without it (CL6a review I2).
 *
 * The Drive import has one file and one model call: when the account's minute
 * or day cap refuses that call, the file was not read, and the honest answer
 * is the quota refusal the composer already shows («جرّب كمان شوي») — not
 * "Google is unavailable", and not an empty review. `shareLlmProvider` names
 * the scope as `cost_cap:<scope>`; nothing else of the error is read.
 */
function modelQuotaScope(error: unknown): QuotaScope | null {
  if (!(error instanceof LLMUnavailableError)) return null;
  const match = /^cost_cap:(\w+)$/.exec(error.reason);
  return match && QUOTA_SCOPES.has(match[1]!) ? match[1] as QuotaScope : null;
}

export function invalidGoogleRequest(): Response {
  return Response.json({ success: false, error: 'invalid_request', reason: 'invalid_request' }, { status: 400 });
}

export function googleFailureResponse(error: unknown): Response {
  if (error instanceof GoogleCalendarConsentError) {
    return Response.json(
      { success: false, error: 'calendar_consent_required', reason: 'calendar_consent_required' },
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
  const scope = modelQuotaScope(error);
  if (scope) {
    const retryAfterSeconds = Math.max(1, retryAfterSecondsFor(scope, new Date()));
    return Response.json(
      { success: false, error: 'ai_quota', reason: 'ai_quota', scope, retryAfterSeconds },
      { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } },
    );
  }
  return googleErrorResponse(error);
}

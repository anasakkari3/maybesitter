import type { Strings } from '../../i18n/strings';
import {
  ContractError,
  ForbiddenError,
  InputTooLargeError,
  InvalidTransitionError,
  NetworkError,
  NotFoundError,
  QuotaExceededError,
  ServerError,
  ServiceUnavailableError,
  StaleCommitmentError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
} from '../errors';

/**
 * The only way an error becomes words a user reads.
 *
 * It never interpolates `error.message`. That message is written for a
 * developer, it changes between releases, and — for a `ValidationError` or a
 * refused parse — it can carry the request that produced it, which means the
 * user's own commitment title. Every branch below returns a fixed key from the
 * locale files, and `errorCopy.test.ts` asserts that no string any locale
 * produces contains "Error:", "http", "backend" or a stack frame.
 *
 * The 403 reasons are not errors at all. `revoked`, `deleted`,
 * `consent_required`, `quiet_mode` and `feature_disabled` are each a state the
 * product has a screen for, and `QueryBoundary` renders that rather than a
 * generic failure. `forbiddenReason` is what tells it which.
 */

export type ForbiddenReason = 'revoked' | 'deleted' | 'consent_required' | 'quiet_mode' | 'feature_disabled';

const FORBIDDEN_REASONS: readonly string[] = [
  'revoked',
  'deleted',
  'consent_required',
  'quiet_mode',
  'feature_disabled',
];

/** The reason a 403 carried, when the product has a screen for it. */
export function forbiddenReason(error: unknown): ForbiddenReason | null {
  if (!(error instanceof ForbiddenError)) return null;
  const reason = error.reason ?? '';
  return FORBIDDEN_REASONS.includes(reason) ? (reason as ForbiddenReason) : null;
}

export function userFacingMessage(error: unknown, t: Strings): string {
  // Before the generic ConflictError branch: both are conflicts, and both are
  // something another device did rather than something the user got wrong.
  if (error instanceof StaleCommitmentError) return t.errorsStaleCommitment;
  if (error instanceof InvalidTransitionError) return t.errorsInvalidTransition;
  // Before the generic branches. A spent quota is not a server fault and not a
  // bad request; it is a limit that will clear, and which one decides the words
  // (#181). `global_daily` is nobody's fault and says so.
  if (error instanceof QuotaExceededError) {
    if (error.scope === 'global_daily') return t.aiServiceUnavailable;
    return error.scope === 'user_minute' ? t.aiQuotaTryLater : t.aiQuotaUserDaily;
  }
  if (error instanceof InputTooLargeError) return t.aiInputTooLong;
  if (error instanceof NetworkError || error instanceof TimeoutError) return t.errorsNetwork;
  if (error instanceof ServerError || error instanceof ServiceUnavailableError || error instanceof ContractError) {
    return t.errorsServer;
  }
  if (error instanceof ValidationError) return t.errorsValidation;
  if (error instanceof UnauthorizedError) return t.authSessionExpired;
  if (error instanceof NotFoundError) return t.errorsNotFound;
  const reason = forbiddenReason(error);
  if (reason === 'revoked') return t.authSignedOutRevoked;
  if (reason === 'deleted') return t.authSignedOutDeleted;
  if (reason === 'consent_required') return t.errorsConsentRequired;
  if (reason === 'quiet_mode') return t.errorsQuietMode;
  if (reason === 'feature_disabled') return t.errorsFeatureDisabled;
  return t.errorsGeneric;
}

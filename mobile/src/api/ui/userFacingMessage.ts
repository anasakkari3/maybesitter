import type { Strings } from '../../i18n/strings';
import {
  ContractError,
  ForbiddenError,
  IcsFeedRefusedError,
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
  UnsupportedShareError,
  UploadTooLargeError,
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
 * It is also the *only* copy table for a failure. A screen that decided its own
 * words from its own state — as the composer once did, with three branches that
 * could not say "the AI quota is spent" at all — is a second table that drifts.
 * Screens ask for a key (`userFacingMessageKey`) or for words
 * (`userFacingMessage`); neither is allowed to write copy of its own.
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

/** One sentence per feed refusal. Never the server's text, never the URL. */
const ICS_FEED_KEYS: Partial<Record<IcsFeedRefusedError['reason'], UserFacingKey>> = {
  invalid_url: 'icsFeedsErrInvalidUrl',
  invalid_request: 'icsFeedsErrInvalidUrl',
  not_a_calendar: 'icsFeedsErrNotCalendar',
  fetch_failed: 'icsFeedsErrFetch',
  calendar_too_complex: 'icsFeedsErrTooComplex',
  too_many_feeds: 'icsFeedsErrTooMany',
  refresh_too_soon: 'icsFeedsErrTooSoon',
  past_due: 'icsFeedsErrPast',
  invalid_action: 'icsFeedsErrChanged',
  item_not_found: 'icsFeedsErrChanged',
  feed_not_found: 'icsFeedsErrChanged',
  encryption_unavailable: 'icsFeedsErrUnavailable',
  feature_disabled: 'icsFeedsUnavailable',
};

/**
 * A locale key this module is allowed to return.
 *
 * Narrowed to the keys whose value is a plain string: one key in the bundle is
 * a list of day names, and `t[key]` has to be something a screen can render.
 */
export type UserFacingKey = {
  [K in keyof Strings]: Strings[K] extends string ? K : never;
}[keyof Strings];

/**
 * The decision itself, as a key rather than as words.
 *
 * Split out of `userFacingMessage` for the composer (#181). That screen holds
 * its failure in a reducer and renders it several frames later, so it needs
 * *which* message this error is without freezing the words — a message resolved
 * at failure time would keep the old language after somebody switched it. The
 * table stays here, once: `userFacingMessage` is this function plus a lookup,
 * and the composer is the same lookup against its own `t`.
 */
export function userFacingMessageKey(error: unknown): UserFacingKey {
  // The calendar feed routes (UC-3.4, #188). First, because their reasons are
  // carried at statuses the generic branches below would flatten: "not a
  // calendar" and "cannot be fetched" are both 422 and ask different things
  // of the user.
  if (error instanceof IcsFeedRefusedError) return ICS_FEED_KEYS[error.reason] ?? 'errorsGeneric';
  // Before the generic ConflictError branch: both are conflicts, and both are
  // something another device did rather than something the user got wrong.
  if (error instanceof StaleCommitmentError) return 'errorsStaleCommitment';
  if (error instanceof InvalidTransitionError) return 'errorsInvalidTransition';
  // Before the generic branches. A spent quota is not a server fault and not a
  // bad request; it is a limit that will clear, and which one decides the words
  // (#181). `global_daily` is nobody's fault and says so.
  if (error instanceof QuotaExceededError) {
    if (error.scope === 'global_daily') return 'aiServiceUnavailable';
    return error.scope === 'user_minute' ? 'aiQuotaTryLater' : 'aiQuotaUserDaily';
  }
  // Before `InputTooLargeError`, whose copy counts characters. A share is
  // refused by size in bytes and by format, and both have their own line (#183).
  if (error instanceof UploadTooLargeError) return 'shareTooLarge';
  if (error instanceof UnsupportedShareError) return 'shareUnsupported';
  if (error instanceof InputTooLargeError) return 'aiInputTooLong';
  if (error instanceof NetworkError || error instanceof TimeoutError) return 'errorsNetwork';
  if (error instanceof ServerError || error instanceof ServiceUnavailableError || error instanceof ContractError) {
    return 'errorsServer';
  }
  if (error instanceof ValidationError) return 'errorsValidation';
  if (error instanceof UnauthorizedError) return 'authSessionExpired';
  if (error instanceof NotFoundError) return 'errorsNotFound';
  const reason = forbiddenReason(error);
  if (reason === 'revoked') return 'authSignedOutRevoked';
  if (reason === 'deleted') return 'authSignedOutDeleted';
  if (reason === 'consent_required') return 'errorsConsentRequired';
  if (reason === 'quiet_mode') return 'errorsQuietMode';
  if (reason === 'feature_disabled') return 'errorsFeatureDisabled';
  return 'errorsGeneric';
}

export function userFacingMessage(error: unknown, t: Strings): string {
  return t[userFacingMessageKey(error)];
}

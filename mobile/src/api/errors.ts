import type { Commitment } from './schemas/common';

/**
 * Every way a call to `/api/mobile/**` can fail, as types the UI can switch on.
 *
 * The rule that makes this worth having: **`message` is never rendered.** It
 * is written for a developer, it can carry the request that produced it, and
 * `ui/userFacingMessage.ts` is the only thing allowed to turn an error into
 * words a user sees. A test asserts that no rendered string contains "Error:",
 * "http" or a stack trace in any of the three locales.
 */

export abstract class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request never reached a server: no signal, DNS, TLS. */
export class NetworkError extends ApiError {}

/** The request reached a server and 15 s passed without an answer. */
export class TimeoutError extends ApiError {}

/** 400 — the server refused what was sent. */
export class ValidationError extends ApiError {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

/**
 * 401 — sign in again. `reason` is the verifier's own code
 * (`missing_token`, `token_expired`, `token_revoked`, `invalid_token`).
 */
export class UnauthorizedError extends ApiError {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

/**
 * 401 `recent_login_required` — the session is **valid**, and the user must
 * not be signed out (UC-1.5 #149).
 *
 * Firebase's `auth_time` is older than the server's five-minute window for a
 * destructive action. The only cure is re-authenticating with the user's own
 * provider, which is a thing the app can do and the user can complete.
 *
 * It is deliberately **not** an `UnauthorizedError`: the generic 401 path
 * refreshes the token once, retries, and signs out. That is wrong twice over
 * here — refreshing an ID token does not change `auth_time`, so the retry is
 * guaranteed to fail, and the sign-out then destroys a perfectly good session
 * and loses the user's place in the deletion flow.
 */
export class RecentLoginRequiredError extends ApiError {
  constructor() {
    super('the account must be re-authenticated before this action');
  }
}

/** 400 `confirmation_required` — the exact confirmation string was missing. */
export class ConfirmationRequiredError extends ApiError {
  constructor() {
    super('the deletion confirmation was not accepted');
  }
}

/**
 * 403 — the credential is fine and re-authenticating will not help.
 * `reason` is `revoked`, `deleted`, `consent_required`, `quiet_mode` or
 * `feature_disabled`, and each of those is a screen rather than an error.
 */
export class ForbiddenError extends ApiError {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

export class NotFoundError extends ApiError {}

/** 409 — someone else moved first. A next-step proposal went stale. */
export class ConflictError extends ApiError {}

/**
 * 409 `stale_commitment` — another device changed this commitment (#148).
 *
 * It carries the commitment **as it actually is**, because that is the
 * difference between "your edit was refused" and "somebody else changed this,
 * here it is". Nothing is resubmitted automatically: the user decides what to
 * do with the version they can now see.
 */
export class StaleCommitmentError extends ConflictError {
  constructor(readonly current: Commitment) {
    super('the commitment changed on another device');
  }
}

/**
 * 409 `invalid_transition` — the move itself was impossible, whatever the
 * screen expected. Completing an already-completed commitment is idempotent;
 * postponing a dropped one is this.
 */
export class InvalidTransitionError extends ConflictError {
  constructor() {
    super('the commitment cannot move that way');
  }
}

/**
 * 409 from the device-calendar link route (UC-3.1, #185).
 *
 * Both reasons mean the same thing to the caller — leave the calendar alone —
 * and mean different things to a person, which is why they are not collapsed:
 *
 * `calendar_link_owned_elsewhere` another installation writes this commitment's
 *                                 event, so this one must not write a second.
 * `calendar_link_detached`        the user deleted the event in their Calendar
 *                                 app, and it is never written again.
 *
 * Neither is shown to anybody. There is nothing for the user to do about
 * either, and a toast saying "another device owns this event" would be the
 * product explaining its own bookkeeping to somebody who did not ask.
 */
export class DeviceCalendarLinkConflictError extends ConflictError {
  constructor(readonly reason: 'calendar_link_owned_elsewhere' | 'calendar_link_detached') {
    super(reason === 'calendar_link_detached'
      ? 'this commitment was removed from the calendar by hand'
      : 'another installation owns this calendar event');
  }
}

/**
 * 429 — a model quota is spent (UC-4.5, #181).
 *
 * Deliberately **not** retryable. It is the one 4xx that will succeed later, and
 * that is exactly why it must not be retried automatically: an automatic retry
 * against a quota is the loop the quota exists to stop, and it would spend the
 * user's remaining budget without them asking.
 *
 * `scope` decides which line the user is shown. `global_daily` is nobody's
 * fault, and its copy says so rather than implying they did something.
 *
 * Whatever the user typed is kept by the composer regardless: losing somebody's
 * words because a counter was full would be the worst possible response.
 */
export type QuotaScope = 'user_daily' | 'user_minute' | 'global_daily';

export class QuotaExceededError extends ApiError {
  constructor(
    readonly scope: QuotaScope,
    readonly retryAfterSeconds: number,
    message = 'the AI quota for this account is spent',
  ) {
    super(message);
  }
}

/** 413 — the input is larger than a model call may carry (UC-4.5, #181). */
export class InputTooLargeError extends ApiError {
  constructor(readonly maxCharacters: number) {
    super(`the text is longer than ${maxCharacters} characters`);
  }
}

/**
 * 413 on an upload — the share is larger than the route accepts (UC-3.0, #183).
 *
 * Separate from `InputTooLargeError`, which is about *characters* and whose
 * copy says so. Telling somebody who shared a 20 MB PDF that "the text is
 * longer than 20000 characters" would be a sentence about something they did
 * not do, and the number in it would be meaningless to them.
 */
export class UploadTooLargeError extends ApiError {
  constructor(readonly maxBytes: number) {
    super(`the share is larger than ${maxBytes} bytes`);
  }
}

/**
 * 415 — the server will not read that kind of file (UC-3.0, #183).
 *
 * Its own type because it is the one refusal on this route the user can act on:
 * every other 4xx here means "try again later" and this one means "that file is
 * not something this app reads".
 */
export class UnsupportedShareError extends ApiError {
  constructor(readonly reason: string) {
    super(`the shared file was refused: ${reason}`);
  }
}

/** 503 — a dependency is down. A retry, never a sign-out. */
export class ServiceUnavailableError extends ApiError {
  constructor(message: string, readonly reason?: string) {
    super(message);
  }
}

export class ServerError extends ApiError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * The response parsed as JSON but is not the shape this client was built
 * against — a backend that changed under a shipped app.
 *
 * It is deliberately distinct from `ServerError`: the server did its job, and
 * the fix is a client release, not a retry. It is reported without the payload,
 * which would carry commitment titles.
 */
export class ContractError extends ApiError {
  constructor(readonly path: string, readonly issues: string[]) {
    super(`response from ${path} did not match the expected shape`);
  }
}

/** A call the build is configured not to make. */
export class UnsupportedError extends ApiError {}

/** Worth another attempt: everything else is the caller's own fault. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof TimeoutError) return true;
  if (error instanceof ServiceUnavailableError) return true;
  return error instanceof ServerError && error.status >= 500;
}

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

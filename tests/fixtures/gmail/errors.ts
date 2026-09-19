/**
 * Gmail API error fixtures.
 *
 * Sources:
 *  - https://developers.google.com/workspace/gmail/api/guides/handle-errors
 *  - https://google.aip.dev/193   (the code/message/status/details envelope)
 *
 * PROVENANCE MARKERS. Read these before trusting a byte:
 *   [DOC]  the status code, `reason` and `message` are stated on Google's
 *          Gmail "Resolve errors" page.
 *   [AIP]  the surrounding envelope (`status`, `details[]`, ErrorInfo) is the
 *          shape AIP-193 mandates for Google JSON APIs; the Gmail page shows
 *          the older `error.errors[]` form only.
 *   [OBS]  field values seen widely in Google client-library issue trackers but
 *          NOT printed in Google's own Gmail documentation. Treat these as
 *          plausible, not authoritative. A classifier MUST NOT key off an
 *          [OBS] value alone — key off HTTP status first, then `reason`.
 *
 * `location` / `locationType` are marked [OBS] throughout.
 */
import type { WireErrorResponse, WireResponseFixture } from './wireTypes';

const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' };

/**
 * 401. [DOC] reason `authError`, message "Invalid Credentials".
 * Documented fix: refresh the access token with the refresh token, or send the
 * user back through the OAuth flow. An expired access token is the ordinary
 * cause, so this is the fixture behind the refresh-then-retry-once test.
 */
export const ERROR_401_INVALID_CREDENTIALS: WireResponseFixture<WireErrorResponse> = {
  status: 401,
  headers: {
    ...JSON_HEADERS,
    // [OBS] Google returns a WWW-Authenticate challenge on 401; the exact text
    // is not in the Gmail docs.
    'www-authenticate': 'Bearer realm="https://accounts.google.com/", error="invalid_token"',
  },
  body: {
    error: {
      code: 401,
      message: 'Invalid Credentials',
      errors: [
        {
          domain: 'global',
          reason: 'authError',
          message: 'Invalid Credentials',
          location: 'Authorization', // [OBS]
          locationType: 'header', // [OBS]
        },
      ],
      status: 'UNAUTHENTICATED', // [AIP]
    },
  },
};

/**
 * 403, insufficient scope. This is NOT one of the four 403 reasons printed on
 * Gmail's error page — the envelope below is [AIP] plus [OBS] values. The one
 * thing to rely on is: HTTP 403 with `status: "PERMISSION_DENIED"` and an
 * ErrorInfo reason of ACCESS_TOKEN_SCOPE_INSUFFICIENT means the granted scopes
 * are too narrow, and retrying is pointless — it needs re-consent.
 */
export const ERROR_403_INSUFFICIENT_SCOPE: WireResponseFixture<WireErrorResponse> = {
  status: 403,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 403,
      message: 'Request had insufficient authentication scopes.', // [OBS]
      errors: [
        {
          domain: 'global',
          reason: 'insufficientPermissions', // [OBS]
          message: 'Insufficient Permission', // [OBS]
        },
      ],
      status: 'PERMISSION_DENIED', // [AIP]
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', // [OBS]
          domain: 'googleapis.com',
          metadata: {
            service: 'gmail.googleapis.com',
            method: 'gmail.users.messages.list',
          },
        },
      ],
    },
  },
};

/** 403, per-user rate limit. [DOC] reason `userRateLimitExceeded`. Retryable with backoff. */
export const ERROR_403_USER_RATE_LIMIT: WireResponseFixture<WireErrorResponse> = {
  status: 403,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 403,
      message: 'User Rate Limit Exceeded',
      errors: [
        { domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' },
      ],
      status: 'PERMISSION_DENIED', // [AIP]
    },
  },
};

/** 403, project rate limit. [DOC] reason `rateLimitExceeded`. Retryable with backoff. */
export const ERROR_403_RATE_LIMIT: WireResponseFixture<WireErrorResponse> = {
  status: 403,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 403,
      message: 'Rate Limit Exceeded',
      errors: [
        { domain: 'usageLimits', reason: 'rateLimitExceeded', message: 'Rate Limit Exceeded' },
      ],
      status: 'PERMISSION_DENIED', // [AIP]
    },
  },
};

/**
 * 403, the Workspace domain admin has turned Gmail API access off.
 * [DOC] reason `domainPolicy`. NOT retryable, and not the user's to fix.
 */
export const ERROR_403_DOMAIN_POLICY: WireResponseFixture<WireErrorResponse> = {
  status: 403,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 403,
      message: 'The domain administrators have disabled Gmail apps.',
      errors: [
        {
          domain: 'global',
          reason: 'domainPolicy',
          message: 'The domain administrators have disabled Gmail apps.',
        },
      ],
      status: 'PERMISSION_DENIED', // [AIP]
    },
  },
};

/**
 * 404 on history.list — the startHistoryId is outside the retained window.
 * [DOC] "an invalid or out of date startHistoryId typically returns an HTTP 404
 * error code", and the client "must perform a full sync". The BODY is [OBS]:
 * Google documents the status, not the JSON.
 *
 * Classify on: history.list + HTTP 404 => stale cursor => drop the cursor and
 * re-baseline from getProfile.historyId. Do NOT treat it as a missing message.
 */
export const ERROR_404_HISTORY_CURSOR_TOO_OLD: WireResponseFixture<WireErrorResponse> = {
  status: 404,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 404,
      message: 'Requested entity was not found.', // [OBS]
      errors: [
        { domain: 'global', reason: 'notFound', message: 'Requested entity was not found.' }, // [OBS]
      ],
      status: 'NOT_FOUND', // [AIP]
    },
  },
};

/** 404 on messages.get — the message id is gone (deleted between list and get). [OBS] body. */
export const ERROR_404_MESSAGE_NOT_FOUND: WireResponseFixture<WireErrorResponse> = {
  status: 404,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 404,
      message: 'Requested entity was not found.', // [OBS]
      errors: [
        { domain: 'global', reason: 'notFound', message: 'Requested entity was not found.' }, // [OBS]
      ],
      status: 'NOT_FOUND', // [AIP]
    },
  },
};

/**
 * 429. [DOC] the status code and that it covers daily per-user limits,
 * bandwidth limits and the per-user concurrent-request limit.
 *
 * RETRY SIGNALLING: Google's Gmail and Workspace quota pages prescribe
 * CLIENT-SIDE truncated exponential backoff —
 *   min((2^n) + random_ms, maximum_backoff), maximum_backoff typically 32–64 s
 * — and do NOT document a `Retry-After` response header for Gmail. No
 * Retry-After is set on this fixture, on purpose. Phase B must compute its own
 * backoff and must not depend on a header Google never promised. See
 * ERROR_429_WITH_RETRY_AFTER for the tolerance case.
 */
export const ERROR_429_TOO_MANY_REQUESTS: WireResponseFixture<WireErrorResponse> = {
  status: 429,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 429,
      message: 'Too many concurrent requests for user.', // [OBS]
      errors: [
        {
          domain: 'usageLimits',
          reason: 'rateLimitExceeded', // [OBS]
          message: 'Too many concurrent requests for user.',
        },
      ],
      status: 'RESOURCE_EXHAUSTED', // [AIP]
    },
  },
};

/**
 * Same 429 but WITH a Retry-After. Undocumented for Gmail, so this exists to
 * prove tolerance, not conformance: if the header is present Phase B may honour
 * it, and must still behave correctly when it is absent.
 */
export const ERROR_429_WITH_RETRY_AFTER: WireResponseFixture<WireErrorResponse> = {
  status: 429,
  headers: { ...JSON_HEADERS, 'retry-after': '30' },
  body: ERROR_429_TOO_MANY_REQUESTS.body,
};

/** 500. [DOC] reason `backendError`, message "Backend Error". Retry with backoff. */
export const ERROR_500_BACKEND: WireResponseFixture<WireErrorResponse> = {
  status: 500,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 500,
      message: 'Backend Error',
      errors: [{ domain: 'global', reason: 'backendError', message: 'Backend Error' }],
      status: 'INTERNAL', // [AIP]
    },
  },
};

/** 503. [DOC] same `backendError` family as 500/502/504. Retry with backoff. */
export const ERROR_503_BACKEND: WireResponseFixture<WireErrorResponse> = {
  status: 503,
  headers: JSON_HEADERS,
  body: {
    error: {
      code: 503,
      message: 'Backend Error',
      errors: [{ domain: 'global', reason: 'backendError', message: 'Backend Error' }],
      status: 'UNAVAILABLE', // [AIP]
    },
  },
};

/**
 * A 502 that is NOT JSON at all — an HTML page from a front-end proxy.
 * Content-Type is text/html, so JSON.parse throws. Real and common; the
 * classifier must not assume every non-2xx has a parseable error envelope.
 */
export const ERROR_502_HTML_BODY: WireResponseFixture<string> = {
  status: 502,
  headers: { 'content-type': 'text/html; charset=UTF-8' },
  body: '<!DOCTYPE html>\n<html><head><title>502 Server Error</title></head><body>\n<h1>Error: Server Error</h1>\n<h2>The server encountered a temporary error and could not complete your request.</h2>\n</body></html>\n',
};

/**
 * 400 invalid_grant from the TOKEN endpoint (oauth2.googleapis.com/token), not
 * from gmail.googleapis.com. Different shape entirely: no `error` envelope.
 * Source: https://developers.google.com/identity/protocols/oauth2/web-server
 * Means the refresh token is dead — re-consent, never retry.
 */
export const ERROR_TOKEN_INVALID_GRANT: WireResponseFixture<{
  error: string;
  error_description: string;
}> = {
  status: 400,
  headers: JSON_HEADERS,
  body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
};

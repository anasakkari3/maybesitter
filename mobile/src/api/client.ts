import type { z } from 'zod';
import { apiBaseUrl } from '../config/env';
import { getIdToken, refreshIdToken, signOutExpired, signOutForbidden } from './auth';
import {
  ConfirmationRequiredError,
  ConflictError,
  ContractError,
  ForbiddenError,
  InvalidTransitionError,
  RecentLoginRequiredError,
  NetworkError,
  NotFoundError,
  ServerError,
  ServiceUnavailableError,
  ApiError,
  QuotaExceededError,
  InputTooLargeError,
  type QuotaScope,
  StaleCommitmentError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
} from './errors';
import { mockResponseFor } from './mockAdapter';
import { commitmentSchema } from './schemas/common';

/**
 * One function every screen's data goes through.
 *
 * `fetch` with an `AbortController`, not axios: the platform already has an
 * HTTP client, and the only thing it lacks — a timeout — is four lines.
 *
 * ── Nothing here is logged ───────────────────────────────────────
 *
 * Not the token, not the body, not the response. A commitment title is the
 * most personal thing this app handles, and a `console.log` left in a client
 * puts it in the device log where any other process can read it. The rule is
 * blanket rather than careful, and `noLogging.test.ts` enforces it.
 */

export const REQUEST_TIMEOUT_MS = 15_000;

// `PUT` joined in UC-2.1 (#161) and UC-2.7a (#167): a consent answer and a
// routine profile are both whole-resource writes, and both have to be safe
// to send twice — which is what lets #167 re-send after a failed sync
// without a replay queue.
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
  /** 201 for the alpha feedback flag; everything else answers 200. */
  expectStatus?: number;
  signal?: AbortSignal;
  /**
   * The `ETag` a previous read returned, sent back as `If-Match` (#148).
   *
   * The server refuses with 409 `stale_commitment` when the commitment has
   * moved since. This is **echoed, never constructed**: the validator is
   * `updatedAt` plus a digest of the commitment, because two changes inside
   * one millisecond share an `updatedAt` and a stale write would slip through.
   * Its shape is the server's to change, so the client only ever repeats it.
   */
  ifMatch?: string;
}

function url(path: string, query: RequestOptions<unknown>['query']): string {
  const base = (apiBaseUrl() ?? '').replace(/\/+$/, '');
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) search.set(key, String(value));
  }
  const suffix = search.toString();
  return `${base}${path}${suffix ? `?${suffix}` : ''}`;
}

interface RawResponse {
  status: number;
  body: unknown;
  /** The commitment's validator, for a later conditional write. */
  etag: string | null;
}

async function send(
  method: HttpMethod,
  target: string,
  body: unknown,
  token: string | null,
  signal: AbortSignal | undefined,
  ifMatch: string | undefined,
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // The caller's own cancellation (a screen unmounting) must also reach fetch.
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (ifMatch) headers['If-Match'] = ifMatch;

  try {
    const response = await fetch(target, {
      method,
      headers,
      // Spread rather than `body: undefined`: the app compiles with
      // exactOptionalPropertyTypes, and `RequestInit.body` does not admit it.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON body from a JSON API is a broken contract, not a server
        // error the user can retry into working.
        throw new ContractError(target, ['response body was not JSON']);
      }
    }
    return { status: response.status, body: parsed, etag: response.headers?.get('etag') ?? null };
  } catch (error) {
    if (error instanceof ContractError) throw error;
    // An abort is either our timeout or the caller's cancellation; both are a
    // request that produced no answer, and the user sees the same thing.
    if (controller.signal.aborted) throw new TimeoutError('the request timed out');
    throw new NetworkError('the request did not reach the server');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

/** `{ error, reason }` out of a refusal body, without trusting its shape. */
function refusal(body: unknown): { message: string; reason: string | undefined } {
  if (body && typeof body === 'object') {
    const record = body as { error?: unknown; reason?: unknown };
    return {
      message: typeof record.error === 'string' ? record.error : 'request refused',
      reason: typeof record.reason === 'string' ? record.reason : undefined,
    };
  }
  return { message: 'request refused', reason: undefined };
}

/**
 * A 409 the client can act on (#148).
 *
 * `stale_commitment` carries `current` — the commitment as it actually is —
 * because "somebody else changed this, here it is" is a different screen from
 * "your edit was refused". `invalid_transition` carries no payload: the move
 * itself was impossible.
 */
function conflictFor(body: unknown): Error {
  if (body && typeof body === 'object') {
    const record = body as { reason?: unknown; current?: unknown };
    if (record.reason === 'stale_commitment') {
      const current = commitmentSchema.safeParse(record.current);
      // A stale response whose `current` will not parse is a contract
      // failure, not a conflict: the screen cannot show what it cannot read.
      if (!current.success) {
        return new ContractError('stale_commitment.current', current.error.issues.map(issue => issue.code));
      }
      return new StaleCommitmentError(current.data);
    }
    if (record.reason === 'invalid_transition') return new InvalidTransitionError();
  }
  return new ConflictError(refusal(body).message);
}

function errorForStatus(status: number, body: unknown): Error {
  const { message, reason } = refusal(body);
  switch (status) {
    case 400:
      // The deletion route's own refusal, so the screen can say what to do
      // rather than showing a generic validation message (#149).
      if (reason === 'confirmation_required') return new ConfirmationRequiredError();
      return new ValidationError(message, reason);
    case 401:
      return new UnauthorizedError(message, reason);
    case 403:
      return new ForbiddenError(message, reason);
    case 404:
      return new NotFoundError(message);
    case 409:
      return conflictFor(body);
    case 413:
      return new InputTooLargeError(
        typeof (body as { maxCharacters?: unknown })?.maxCharacters === 'number'
          ? (body as { maxCharacters: number }).maxCharacters
          : 20_000,
      );
    case 429:
      return quotaFor(body, message);
    case 503:
      return new ServiceUnavailableError(message, reason);
    default:
      return new ServerError(message, status);
  }
}

/**
 * A 429 from the model quota, or a plain one if the body says nothing (#181).
 *
 * The scope is trusted only when it is one of the three the contract names; an
 * unrecognised value falls back to `user_daily`, which is the answer that asks
 * the user to wait rather than blaming the service for something it may not
 * have done.
 */
function quotaFor(body: unknown, message: string): ApiError {
  const refusalBody = body as { scope?: unknown; retryAfterSeconds?: unknown } | null;
  const scopes: QuotaScope[] = ['user_daily', 'user_minute', 'global_daily'];
  const scope = scopes.find(candidate => candidate === refusalBody?.scope) ?? 'user_daily';
  const retryAfter = typeof refusalBody?.retryAfterSeconds === 'number' && refusalBody.retryAfterSeconds > 0
    ? Math.ceil(refusalBody.retryAfterSeconds)
    : 60;
  return new QuotaExceededError(scope, retryAfter, message);
}

/** A parsed body plus the validator to send back on a conditional write. */
export interface TaggedResult<T> {
  data: T;
  etag: string | null;
}

export async function apiRequest<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<T>,
): Promise<T> {
  return (await apiRequestTagged(method, path, options)).data;
}

export async function apiRequestTagged<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<T>,
): Promise<TaggedResult<T>> {
  const target = url(path, options.query);
  const expected = options.expectStatus ?? 200;

  // Development only, and impossible in a release build three times over
  // (see ./mockAdapter.ts). Placed here so every endpoint, error type and
  // schema check below is exercised exactly as it is against a real server.
  const mocked = mockResponseFor(method, path);
  let response: RawResponse = mocked
    ? { status: mocked.status, body: mocked.body, etag: null }
    : await send(method, target, options.body, await getIdToken(), options.signal, options.ifMatch);

  if (response.status === 401 && refusal(response.body).reason === 'recent_login_required') {
    // Before the refresh, and before any sign-out (#149).
    //
    // This 401 does not mean the credential is bad — it means `auth_time` is
    // older than the server's window for a destructive action. Refreshing an
    // ID token does **not** change `auth_time`, so the generic path below
    // would retry into the identical 401 and then sign the user out: a valid
    // session destroyed, and the user thrown out of the flow they were in.
    //
    // The caller re-authenticates with the user's own provider and asks again.
    throw new RecentLoginRequiredError();
  }

  if (response.status === 401) {
    // Exactly one forced refresh and one retry. Concurrent 401s share the
    // refresh (see ./auth.ts), so three parallel calls cause one round trip.
    const fresh = await refreshIdToken();
    if (fresh) {
      response = await send(method, target, options.body, fresh, options.signal, options.ifMatch);
    }
    if (response.status === 401) {
      // The session is genuinely over. Signing out here rather than letting
      // each screen decide is what makes "Please sign in again" appear once,
      // on the sign-in screen, instead of an error toast on every tab.
      await signOutExpired();
      throw errorForStatus(401, response.body);
    }
  }

  if (response.status === 403) {
    const { reason } = refusal(response.body);
    // A revoked or deleted account cannot be recovered by retrying; the app
    // has to return to sign-in with the reason the user will be shown.
    if (reason === 'revoked' || reason === 'deleted') await signOutForbidden(reason);
    throw errorForStatus(403, response.body);
  }

  if (response.status !== expected) throw errorForStatus(response.status, response.body);

  const parsed = options.schema.safeParse(response.body);
  if (!parsed.success) {
    // Paths and field names only. The payload itself never leaves this
    // function — it holds the user's commitments.
    throw new ContractError(
      path,
      parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.code}`),
    );
  }
  return { data: parsed.data, etag: response.etag };
}

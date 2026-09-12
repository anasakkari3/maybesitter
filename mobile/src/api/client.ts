import type { z } from 'zod';
import { apiBaseUrl } from '../config/env';
import { getIdToken, refreshIdToken, signOutExpired, signOutForbidden } from './auth';
import {
  ConflictError,
  ContractError,
  ForbiddenError,
  NetworkError,
  NotFoundError,
  ServerError,
  ServiceUnavailableError,
  TimeoutError,
  UnauthorizedError,
  ValidationError,
} from './errors';

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

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
  /** 201 for the alpha feedback flag; everything else answers 200. */
  expectStatus?: number;
  signal?: AbortSignal;
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
}

async function send(
  method: HttpMethod,
  target: string,
  body: unknown,
  token: string | null,
  signal: AbortSignal | undefined,
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // The caller's own cancellation (a screen unmounting) must also reach fetch.
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

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
    return { status: response.status, body: parsed };
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

function errorForStatus(status: number, body: unknown): Error {
  const { message, reason } = refusal(body);
  switch (status) {
    case 400:
      return new ValidationError(message, reason);
    case 401:
      return new UnauthorizedError(message, reason);
    case 403:
      return new ForbiddenError(message, reason);
    case 404:
      return new NotFoundError(message);
    case 409:
      return new ConflictError(message);
    case 503:
      return new ServiceUnavailableError(message, reason);
    default:
      return new ServerError(message, status);
  }
}

export async function apiRequest<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions<T>,
): Promise<T> {
  const target = url(path, options.query);
  const expected = options.expectStatus ?? 200;

  let response = await send(method, target, options.body, await getIdToken(), options.signal);

  if (response.status === 401) {
    // Exactly one forced refresh and one retry. Concurrent 401s share the
    // refresh (see ./auth.ts), so three parallel calls cause one round trip.
    const fresh = await refreshIdToken();
    if (fresh) {
      response = await send(method, target, options.body, fresh, options.signal);
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
  return parsed.data;
}

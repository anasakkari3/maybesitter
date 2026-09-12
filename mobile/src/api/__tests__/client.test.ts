import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { apiRequest } from '../client';
import { resetAuthForTests, setAuthRepository } from '../auth';
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
  isRetryable,
} from '../errors';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../auth/fakeAuthRepository';
import type { AuthUser } from '../../auth/types';

/**
 * The 401 path is the reason this client exists rather than a bare `fetch`.
 *
 * Tokens expire every hour, the app loads several screens at once, and the
 * naive implementations of this are all wrong in the same two ways: they
 * refresh once per failing request, and they either retry forever or sign the
 * user out on the first blip.
 */

const USER: AuthUser = {
  uid: 'u1',
  email: 'someone@example.com',
  emailVerified: true,
  displayName: null,
  providerIds: ['password'],
};

const okSchema = z.object({ ok: z.boolean() });

type FetchCall = { url: string; init: RequestInit };

let calls: FetchCall[] = [];
let repository: FakeAuthRepository;

/** Queues the responses `fetch` will return, in order. */
function respondWith(...responses: Array<{ status: number; body?: unknown }>): void {
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return {
      status: response!.status,
      text: async () => (response!.body === undefined ? '' : JSON.stringify(response!.body)),
    };
  }) as never;
}

function authHeaderOf(call: FetchCall): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.Authorization;
}

beforeEach(() => {
  calls = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  repository = createFakeAuthRepository({ initialUser: USER, idToken: 'token-1' });
  setAuthRepository(repository);
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('sending a request', () => {
  it('attaches the current ID token as a bearer', async () => {
    respondWith({ status: 200, body: { ok: true } });
    await apiRequest('GET', '/api/mobile/x', { schema: okSchema });
    expect(authHeaderOf(calls[0]!)).toBe('Bearer token-1');
  });

  it('builds the URL from the base and the query, dropping undefined values', async () => {
    respondWith({ status: 200, body: { ok: true } });
    await apiRequest('GET', '/api/mobile/x', {
      schema: okSchema,
      query: { timezone: 'Asia/Jerusalem', referenceTime: undefined },
    });
    expect(calls[0]!.url).toBe('http://localhost:3000/api/mobile/x?timezone=Asia%2FJerusalem');
  });

  it('sends no Authorization header when nobody is signed in', async () => {
    setAuthRepository(createFakeAuthRepository({ initialUser: null }));
    respondWith({ status: 200, body: { ok: true } });
    await apiRequest('GET', '/api/mobile/x', { schema: okSchema });
    expect(authHeaderOf(calls[0]!)).toBeUndefined();
  });
});

describe('a 401', () => {
  it('forces exactly one refresh and retries once', async () => {
    respondWith({ status: 401, body: { success: false, error: 'expired' } }, { status: 200, body: { ok: true } });
    repository.setIdToken('token-2');
    await apiRequest('GET', '/api/mobile/x', { schema: okSchema });

    expect(calls).toHaveLength(2);
    expect(repository.forcedRefreshes).toBe(1);
    expect(authHeaderOf(calls[1]!)).toBe('Bearer token-2');
    expect(repository.signOutReasons).toEqual([]);
  });

  it('signs out with session_expired when the retry is refused too', async () => {
    respondWith({ status: 401, body: { success: false, error: 'expired', reason: 'token_expired' } });
    await expect(apiRequest('GET', '/api/mobile/x', { schema: okSchema })).rejects.toBeInstanceOf(UnauthorizedError);

    expect(calls).toHaveLength(2);
    expect(repository.forcedRefreshes).toBe(1);
    // This is what puts "Please sign in again" on the sign-in screen.
    expect(repository.signOutReasons).toEqual(['session_expired']);
  });

  it('shares one refresh across three concurrent 401s', async () => {
    respondWith({ status: 401, body: { success: false, error: 'expired' } }, { status: 200, body: { ok: true } });
    // Every call 401s first, so all three race into the refresh at once.
    let index = 0;
    (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const status = index < 3 ? 401 : 200;
      index += 1;
      return { status, text: async () => JSON.stringify(status === 200 ? { ok: true } : { success: false, error: 'x' }) };
    }) as never;

    await Promise.all([
      apiRequest('GET', '/api/mobile/a', { schema: okSchema }),
      apiRequest('GET', '/api/mobile/b', { schema: okSchema }),
      apiRequest('GET', '/api/mobile/c', { schema: okSchema }),
    ]);

    expect(calls).toHaveLength(6);
    expect(repository.forcedRefreshes).toBe(1);
  });

  it('does not retry when the refresh yields nothing', async () => {
    respondWith({ status: 401, body: { success: false, error: 'expired' } });
    repository.setIdToken(null);
    await expect(apiRequest('GET', '/api/mobile/x', { schema: okSchema })).rejects.toBeInstanceOf(UnauthorizedError);
    expect(calls).toHaveLength(1);
    expect(repository.signOutReasons).toEqual(['session_expired']);
  });
});

describe('a 403', () => {
  it.each(['revoked', 'deleted'] as const)('signs out for %s, which re-authenticating cannot fix', async reason => {
    respondWith({ status: 403, body: { success: false, error: 'no', reason } });
    await expect(apiRequest('GET', '/api/mobile/x', { schema: okSchema })).rejects.toBeInstanceOf(ForbiddenError);
    expect(repository.signOutReasons).toEqual([reason]);
    expect(repository.forcedRefreshes).toBe(0);
  });

  it('keeps the session for a consent refusal, which is a screen not an error', async () => {
    respondWith({ status: 403, body: { success: false, error: 'no', reason: 'consent_required' } });
    const error = await apiRequest('GET', '/api/mobile/x', { schema: okSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect((error as ForbiddenError).reason).toBe('consent_required');
    expect(repository.signOutReasons).toEqual([]);
  });
});

describe('every other status maps to its own type', () => {
  it.each([
    [400, ValidationError],
    [404, NotFoundError],
    [409, ConflictError],
    [500, ServerError],
    [503, ServiceUnavailableError],
  ])('%s', async (status, type) => {
    respondWith({ status, body: { success: false, error: 'refused' } });
    await expect(apiRequest('GET', '/api/mobile/x', { schema: okSchema })).rejects.toBeInstanceOf(type);
  });

  it('accepts the 201 the alpha feedback flag answers with', async () => {
    respondWith({ status: 201, body: { ok: true } });
    await expect(apiRequest('POST', '/api/mobile/x', { schema: okSchema, expectStatus: 201 })).resolves.toEqual({ ok: true });
  });

  it('treats an unexpected 200 as the status mismatch it is', async () => {
    respondWith({ status: 200, body: { ok: true } });
    await expect(
      apiRequest('POST', '/api/mobile/x', { schema: okSchema, expectStatus: 201 }),
    ).rejects.toBeInstanceOf(ServerError);
  });
});

describe('transport failures', () => {
  it('reports a failed fetch as a network error, not a server one', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    }) as never;
    await expect(apiRequest('GET', '/api/mobile/x', { schema: okSchema })).rejects.toBeInstanceOf(NetworkError);
  });

  it('reports a non-JSON body as broken contract, not a retryable server error', async () => {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
      status: 200,
      text: async () => '<html>gateway</html>',
    })) as never;
    await expect(apiRequest('GET', '/api/mobile/x', { schema: okSchema })).rejects.toBeInstanceOf(ContractError);
  });

  it('reports a response that lost a field as broken contract', async () => {
    respondWith({ status: 200, body: { notOk: true } });
    const error = await apiRequest('GET', '/api/mobile/x', { schema: okSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
    // Field names and paths only: the payload holds commitment titles.
    expect((error as ContractError).issues.join(' ')).not.toContain('notOk');
  });
});

describe('what is worth retrying', () => {
  it('retries only what another attempt can fix', () => {
    expect(isRetryable(new NetworkError('x'))).toBe(true);
    expect(isRetryable(new TimeoutError('x'))).toBe(true);
    expect(isRetryable(new ServiceUnavailableError('x'))).toBe(true);
    expect(isRetryable(new ServerError('x', 502))).toBe(true);

    expect(isRetryable(new ValidationError('x'))).toBe(false);
    expect(isRetryable(new NotFoundError('x'))).toBe(false);
    expect(isRetryable(new ConflictError('x'))).toBe(false);
    expect(isRetryable(new UnauthorizedError('x'))).toBe(false);
    expect(isRetryable(new ForbiddenError('x'))).toBe(false);
    expect(isRetryable(new ContractError('/x', []))).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mockModeActive, mockResponseFor } from '../mockAdapter';
import { apiRequest } from '../client';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { listToday, listUpcoming } from '../endpoints/commitments';
import { proposeCapture } from '../endpoints/capture';
import { getTrust } from '../endpoints/trust';
import { commitmentListSchema } from '../schemas/common';
import { ServerError } from '../errors';
import { releaseConfigProblems } from '../../config/releaseGuard';

/**
 * Mock mode (UC-1.R4 #157 step 10).
 *
 * The point is not "a fake exists" — it is that the fake is the **real
 * routes' own output**, so a screen built against it is built against the
 * contract, and that it is impossible to ship.
 */

const ORIGINAL = {
  mode: process.env.EXPO_PUBLIC_API_MODE,
  appEnv: process.env.EXPO_PUBLIC_APP_ENV,
};

function setMode(mode: string | undefined, appEnv = 'development'): void {
  if (mode === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
  else process.env.EXPO_PUBLIC_API_MODE = mode;
  process.env.EXPO_PUBLIC_APP_ENV = appEnv;
}

let fetchCalls = 0;

beforeEach(() => {
  fetchCalls = 0;
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
  // Any network call at all is a failure in mock mode.
  (globalThis as { fetch: unknown }).fetch = jest.fn(async () => {
    fetchCalls += 1;
    throw new Error('mock mode must not reach the network');
  }) as never;
});

afterEach(() => {
  setMode(ORIGINAL.mode, ORIGINAL.appEnv ?? 'development');
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('when it is active', () => {
  it('is off unless the build is a development one asking for it', () => {
    setMode(undefined);
    expect(mockModeActive()).toBe(false);
    setMode('api');
    expect(mockModeActive()).toBe(false);
    setMode('mock');
    expect(mockModeActive()).toBe(true);
    // `apiMode()` refuses it outside a development bundle regardless.
    setMode('mock', 'production');
    expect(mockModeActive()).toBe(false);
    setMode('mock', 'staging');
    expect(mockModeActive()).toBe(false);
  });

  it('answers nothing at all when it is off', () => {
    setMode('api');
    expect(mockResponseFor('GET', '/api/mobile/commitments/today')).toBeNull();
  });

  it.each(['staging', 'production'] as const)('cannot be built into a %s app', appEnv => {
    // The stop that matters most: not "the fake is inert" but "the binary
    // cannot be made". `appConfig.test.ts` proves it through a real
    // `expo config` run as well.
    expect(
      releaseConfigProblems({ appEnv, apiBaseUrl: 'https://api.example.com', apiMode: 'mock' }),
    ).toContain('EXPO_PUBLIC_API_MODE=mock must not be set in a staging or production build');
  });
});

describe('serving the real routes own output', () => {
  beforeEach(() => setMode('mock'));

  it('serves today and upcoming without touching the network', async () => {
    const today = await listToday({ timezone: 'UTC' });
    const upcoming = await listUpcoming({ timezone: 'UTC' });
    expect(Array.isArray(today.items)).toBe(true);
    expect(upcoming.items.length).toBeGreaterThan(0);
    expect(fetchCalls).toBe(0);
  });

  it('serves a response that passes the shipped schema', async () => {
    // The fixtures came from the route handlers, so the schema the app ships
    // validates them — a screen built here is built against the contract.
    const today = await listToday({ timezone: 'UTC' });
    expect(commitmentListSchema.safeParse(today).success).toBe(true);
  });

  it('serves capture and trust too', async () => {
    const proposal = await proposeCapture({ text: 'anything', timezone: 'UTC' });
    expect(proposal.status).toBe('proposed');
    const trust = await getTrust();
    expect(trust.success).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it('picks the more specific route when two patterns could match', () => {
    // `/commitments/{id}/actions` must not be served the single-commitment
    // fixture, and `/capture/confirm` must not be served the proposal.
    expect(mockResponseFor('POST', '/api/mobile/commitments/abc/actions')?.body).toHaveProperty('commitment');
    expect(mockResponseFor('POST', '/api/mobile/capture/confirm')?.body).toHaveProperty('persisted');
  });

  it('answers 501 for an unmapped route rather than falling through', async () => {
    // Silently reaching a network the developer told us not to use would make
    // a missing fixture look like a backend problem.
    const error = await apiRequest('GET', '/api/mobile/something/unmapped', {
      schema: commitmentListSchema,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).status).toBe(501);
    expect(fetchCalls).toBe(0);
  });

  it('refuses to fake an account deletion', async () => {
    // A receipt for an account that still exists is the one lie here with no
    // recoverable version.
    expect(mockResponseFor('DELETE', '/api/mobile/account')?.status).toBe(501);
  });

  it('accumulates nothing between calls', async () => {
    // No in-memory store pretending to be a database. The retired Flutter
    // client's mock mode persisted the user's edits, which is how a developer
    // comes to trust a fake (#148).
    const first = await listUpcoming({ timezone: 'UTC' });
    await proposeCapture({ text: 'a new commitment', timezone: 'UTC' });
    const second = await listUpcoming({ timezone: 'UTC' });
    expect(second.items.length).toBe(first.items.length);
  });
});

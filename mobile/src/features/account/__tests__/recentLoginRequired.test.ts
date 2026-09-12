import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resetAuthForTests, setAuthRepository } from '../../../api/auth';
import { createFakeAuthRepository, type FakeAuthRepository } from '../../../auth/fakeAuthRepository';
import { deleteAccount } from '../../../api/endpoints/account';
import { apiRequest } from '../../../api/client';
import {
  ConfirmationRequiredError,
  RecentLoginRequiredError,
  UnauthorizedError,
} from '../../../api/errors';
import { accountDeletionResponseSchema } from '../../../api/schemas/account';

/**
 * The 401 that must not sign anybody out (UC-1.5 #149).
 *
 * The generic 401 path refreshes the token once, retries, and on a second 401
 * signs out with `session_expired`. For `recent_login_required` that is wrong
 * twice over:
 *
 *  1. refreshing an ID token does **not** change `auth_time`, so the retry is
 *     guaranteed to hit the identical 401;
 *  2. the sign-out then destroys a perfectly valid session and throws the user
 *     out of the deletion flow they were halfway through.
 *
 * These are the guard-reversal tests for that: make this reason take the
 * generic path and they fail.
 */

let requests: { method: string; body: unknown }[] = [];
let repository: FakeAuthRepository;

function respondWith(...responses: { status: number; body?: unknown }[]): void {
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (_url: string, init: RequestInit) => {
    requests.push({
      method: init.method as string,
      body: init.body === undefined ? undefined : JSON.parse(init.body as string),
    });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return {
      status: response.status,
      text: async () => (response.body === undefined ? '' : JSON.stringify(response.body)),
      headers: { get: () => null },
    };
  }) as never;
}

const RECEIPT = {
  success: true,
  receipt: {
    receiptId: '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9',
    deletedAt: '2026-09-12T12:00:00.000Z',
    steps: {
      markDeleted: 'done',
      revokeSessions: 'done',
      externalRevocations: 'done',
      topLevelDocs: 'done',
      authUser: 'done',
      userTree: 'done',
      receipt: 'done',
    },
  },
};

beforeEach(() => {
  requests = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  repository = createFakeAuthRepository({
    initialUser: { uid: 'u1', email: 'someone@example.com', emailVerified: true, displayName: null, providerIds: ['password'] },
  });
  setAuthRepository(repository);
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('recent_login_required', () => {
  const body = { success: false, error: 'recent login required', reason: 'recent_login_required' };

  it('throws its own type, not UnauthorizedError', async () => {
    respondWith({ status: 401, body });
    const error = await deleteAccount().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecentLoginRequiredError);
    // Anything catching UnauthorizedError would treat this as a dead session.
    expect(error).not.toBeInstanceOf(UnauthorizedError);
  });

  it('does NOT sign the user out', async () => {
    respondWith({ status: 401, body });
    await deleteAccount().catch(() => {});
    // The single most important assertion in this file. The session is valid;
    // the user is mid-flow; signing them out loses both.
    expect(repository.signOutReasons).toEqual([]);
    expect(repository.currentUser()).not.toBeNull();
  });

  it('does NOT force a token refresh', async () => {
    respondWith({ status: 401, body });
    await deleteAccount().catch(() => {});
    // `auth_time` does not change on a refresh, so the refresh is pure waste
    // and the retry it enables is guaranteed to fail.
    expect(repository.forcedRefreshes).toBe(0);
  });

  it('makes exactly one request — no blind retry', async () => {
    respondWith({ status: 401, body });
    await deleteAccount().catch(() => {});
    expect(requests).toHaveLength(1);
  });
});

describe('every other 401 keeps its existing behaviour', () => {
  it.each([
    ['token_expired'],
    ['token_revoked'],
    ['invalid_token'],
    ['missing_token'],
  ])('%s still refreshes, retries once and signs out', async reason => {
    respondWith({ status: 401, body: { success: false, error: 'no', reason } });
    const error = await apiRequest('GET', '/api/mobile/commitments/today', {
      schema: accountDeletionResponseSchema,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnauthorizedError);
    expect(error).not.toBeInstanceOf(RecentLoginRequiredError);
    expect(repository.forcedRefreshes).toBe(1);
    expect(requests).toHaveLength(2);
    expect(repository.signOutReasons).toEqual(['session_expired']);
  });

  it('a 401 with no reason at all still signs out', async () => {
    respondWith({ status: 401, body: { success: false, error: 'no' } });
    await apiRequest('GET', '/api/mobile/x', { schema: accountDeletionResponseSchema }).catch(() => {});
    expect(repository.signOutReasons).toEqual(['session_expired']);
  });
});

describe('the deletion request itself', () => {
  it('sends DELETE with the exact confirmation string', async () => {
    respondWith({ status: 200, body: RECEIPT });
    await deleteAccount();
    expect(requests).toEqual([
      { method: 'DELETE', body: { confirmation: 'delete-my-account' } },
    ]);
  });

  it('returns the receipt and nothing else', async () => {
    respondWith({ status: 200, body: RECEIPT });
    const receipt = await deleteAccount();
    expect(receipt.receiptId).toBe(RECEIPT.receipt.receiptId);
    expect(receipt.deletedAt).toBe(RECEIPT.receipt.deletedAt);
    expect(receipt.steps.authUser).toBe('done');
    // No uid, email or subject hash is in the contract, so none can leak.
    expect(Object.keys(receipt).sort()).toEqual(['deletedAt', 'receiptId', 'steps']);
  });

  it('makes no further authenticated request after success', async () => {
    respondWith({ status: 200, body: RECEIPT });
    await deleteAccount();
    // The server has already deleted the Firebase user: the token in hand is
    // dead, and another call would 401 into the generic session-expired path.
    expect(requests).toHaveLength(1);
  });

  it('maps a missing confirmation to its own type', async () => {
    respondWith({ status: 400, body: { success: false, error: 'confirmation required', reason: 'confirmation_required' } });
    const error = await deleteAccount().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfirmationRequiredError);
  });

  it('accepts a receipt whose step list has grown', async () => {
    // The server owns DELETION_STEPS. A client that refused an unfamiliar step
    // would break on a backend change while the receipt id — the thing the
    // user actually needs — had arrived intact.
    respondWith({
      status: 200,
      body: { ...RECEIPT, receipt: { ...RECEIPT.receipt, steps: { ...RECEIPT.receipt.steps, somethingNew: 'skipped' } } },
    });
    const receipt = await deleteAccount();
    expect(receipt.steps.somethingNew).toBe('skipped');
  });

  it('refuses a receipt with no receiptId', async () => {
    respondWith({ status: 200, body: { success: true, receipt: { deletedAt: RECEIPT.receipt.deletedAt, steps: {} } } });
    await expect(deleteAccount()).rejects.toThrow();
  });
});

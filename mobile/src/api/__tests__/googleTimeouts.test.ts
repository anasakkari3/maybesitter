import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { importDriveFile, getGoogleStatus, scanGmail } from '../endpoints/google';
import { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } from '../client';
import { TimeoutError } from '../errors';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';

/**
 * The Gmail scan and the Drive import wait as long as a share does (CL6a
 * review I2).
 *
 * Both do a share's worth of work on the server — mail or a file fetched from
 * Google, then the model — and the fifteen-second lookup deadline would have
 * shown "no connection" for a read that was about to answer. A lookup on the
 * same routes (the status) keeps the short deadline.
 */

let signals: AbortSignal[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  signals = [];
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'u1', email: 'a@b.c', emailVerified: true, displayName: null, providerIds: ['password'] },
    idToken: 'token-1',
  }));
  // A server that never answers: only the client's own deadline ends the request.
  (globalThis as { fetch: unknown }).fetch = jest.fn((_url: string, init: RequestInit) => {
    signals.push(init.signal as AbortSignal);
    return new Promise((_resolve, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  }) as never;
});

afterEach(() => {
  jest.useRealTimers();
  resetAuthForTests();
});

async function stillWaitingAfter(ms: number, pending: Promise<unknown>): Promise<boolean> {
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await jest.advanceTimersByTimeAsync(ms);
  return !settled;
}

describe('the long reads', () => {
  it.each([
    ['the Gmail scan', () => scanGmail({ timezone: 'Asia/Jerusalem' })],
    ['the Drive import', () => importDriveFile({ fileId: 'doc_abcdefghij', timezone: 'Asia/Jerusalem' })],
  ])('%s is still waiting after the fifteen-second lookup deadline, and gives up at sixty', async (_name, call) => {
    const pending = call();
    pending.catch(() => undefined);
    expect(await stillWaitingAfter(REQUEST_TIMEOUT_MS + 1_000, pending)).toBe(true);
    expect(signals[0]!.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(UPLOAD_TIMEOUT_MS - REQUEST_TIMEOUT_MS);
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });

  it('a lookup on the same routes keeps the short deadline', async () => {
    const pending = getGoogleStatus();
    pending.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    await expect(pending).rejects.toBeInstanceOf(TimeoutError);
  });
});

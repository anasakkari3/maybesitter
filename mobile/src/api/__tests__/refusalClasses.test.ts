/**
 * Two refusals the client used to flatten, read from the routes' real bodies.
 *
 *   - `moduleGate.ts` answers a switched-off module with 404
 *     `{ reason: 'feature_unavailable' }`. Every 404 became "هاد ما عاد موجود"
 *     ("that's gone") — for something that was never on.
 *   - The capture confirm answers a refusal with 404/400 and the confirmation
 *     body, whose `failureCode` is the only thing that says what to do next.
 *     The generic classes dropped it.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { apiRequest } from '../client';
import { confirmCapture } from '../endpoints/capture';
import { CaptureConfirmRefusedError, FeatureUnavailableError, NotFoundError } from '../errors';
import { forbiddenReason, userFacingMessageKey } from '../ui/userFacingMessage';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { z } from 'zod';
import confirmationFailed from '../__fixtures__/capture.confirmationFailed.json';

const anyBody = z.object({}).passthrough();

function serve(body: unknown, status: number): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
    status,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  })) as never;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'refusal-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('reads a switched-off module as "not available yet", and still as a 404', async () => {
  // The exact body `moduleDisabledResponse` returns.
  serve({ success: false, error: 'not found', reason: 'feature_unavailable' }, 404);
  const error = await apiRequest('GET', '/api/mobile/memory', { schema: anyBody }).catch(caught => caught);
  expect(error).toBeInstanceOf(FeatureUnavailableError);
  // The memory card and the memory screen hide on a 404; they still do.
  expect(error).toBeInstanceOf(NotFoundError);
  expect(userFacingMessageKey(error)).toBe('errorsFeatureDisabled');
  expect(forbiddenReason(error)).toBe('feature_disabled');
});

it('still calls an ordinary 404 gone', async () => {
  serve({ success: false, error: 'not found' }, 404);
  const error = await apiRequest('GET', '/api/mobile/memory', { schema: anyBody }).catch(caught => caught);
  expect(error).not.toBeInstanceOf(FeatureUnavailableError);
  expect(userFacingMessageKey(error)).toBe('errorsNotFound');
});

it('keeps a refused confirm\'s reason, from the route\'s own body', async () => {
  serve(confirmationFailed, 404);
  const error = await confirmCapture({ proposalId: 'gone', itemIds: ['i1'] }).catch(caught => caught);
  expect(error).toBeInstanceOf(CaptureConfirmRefusedError);
  expect((error as CaptureConfirmRefusedError).failureCode).toBe(confirmationFailed.failureCode);
  expect(userFacingMessageKey(error)).toBe('captureConfirmExpired');
});

it('gives each confirm refusal its own line', () => {
  expect(userFacingMessageKey(new CaptureConfirmRefusedError('invalid_selection'))).toBe('captureConfirmNothingReady');
  expect(userFacingMessageKey(new CaptureConfirmRefusedError('invalid_edit'))).toBe('captureConfirmBadEdit');
  expect(userFacingMessageKey(new CaptureConfirmRefusedError('persistence_failed'))).toBe('errorsServer');
});

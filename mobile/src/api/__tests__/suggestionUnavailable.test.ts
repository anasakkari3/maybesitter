/**
 * M5b-2b-1 (R4-003, R3): the client side of the suggestion refusal and the
 * suggestion's memory basis, beyond the acceptance gate.
 *
 *   - `suggestion_unavailable` is typed only on the suggestion routes; the
 *     same reason anywhere else stays an ordinary 404 (an ordinary 404 is an
 *     error the person sees, never a card quietly refreshed away).
 *   - A server that sent more than three basis ids cuts to three; it does
 *     not fail the whole inbox.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { apiRequest } from '../client';
import { NotFoundError, SuggestionUnavailableError } from '../errors';
import { intelligenceInboxSchema } from '../schemas/intelligence';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../auth';

const anyBody = z.object({}).passthrough();
const UNAVAILABLE = { success: false, error: 'not_found', reason: 'suggestion_unavailable' };

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
    initialUser: { uid: 'suggestion-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('R4-003 types suggestion_unavailable on a suggestion route, still as a 404', async () => {
  serve(UNAVAILABLE, 404);
  const error = await apiRequest('POST', '/api/mobile/intelligence/suggestions/s1/answer', { body: { answer: 'x' }, schema: anyBody })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(SuggestionUnavailableError);
  expect(error).toBeInstanceOf(NotFoundError);
});

it('R4-003 keeps the same reason on any other route an ordinary 404', async () => {
  serve(UNAVAILABLE, 404);
  const error = await apiRequest('GET', '/api/mobile/intelligence', { schema: anyBody }).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(NotFoundError);
  expect(error).not.toBeInstanceOf(SuggestionUnavailableError);
});

it('R3 cuts an over-long memory basis to three ids instead of failing the inbox', () => {
  const parsed = intelligenceInboxSchema.parse({
    success: true, observations: [], schedule: [], basisMode: 'on_basis',
    suggestions: [{
      id: 's1', kind: 'action', title: 't', reason: 'r', observationIds: [], confidence: 0.5, durationMinutes: 30,
      status: 'pending', decidedAt: null, linkedEntityId: null, generatedAt: '2030-03-29T08:30:00.000Z',
      memoryBasis: [{ memoryId: 'a' }, { memoryId: 'b' }, { memoryId: 'c' }, { memoryId: 'd' }],
    }],
  });
  expect(parsed.suggestions[0]!.memoryBasis).toEqual([{ memoryId: 'a' }, { memoryId: 'b' }, { memoryId: 'c' }]);
});

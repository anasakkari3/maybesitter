/** M2a · Task A · criterion 4 — tolerant optional fields through the real HTTP client. */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { chatCapture } from '../../api/endpoints/capture';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../../api/auth';

const USER = { uid: 'm2a-http-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };

function response(proposal: Record<string, unknown>) {
  return {
    conversationId: 'conversation-1', reply: 'Understood.', engine: 'rules',
    turns: [{ role: 'user', text: 'meeting' }, { role: 'assistant', text: 'Understood.' }],
    proposal,
  };
}

function serve(...bodies: unknown[]): void {
  let index = 0;
  (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify(bodies[Math.min(index++, bodies.length - 1)]),
  })) as never;
}

const item = {
  itemId: 'item-1', title: 'Meeting', resolvedTime: '2030-01-07T16:00:00.000Z',
  endTime: 'not-an-instant', needsClarification: false,
};
const seed = { seedItemId: 'seed-1', kind: 'consideration', summary: 'Move closer to work' };
const base = { version: 'v1', proposalId: 'proposal-1', status: 'proposed', items: [item], seeds: [seed] };

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({ initialUser: USER, idToken: 'token' }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

it('A4 tolerant parsing: malformed shapes and broken invariants are dropped by chatCapture while the answer survives', async () => {
  serve(
    response({ ...base, understood: 'not-a-list' }),
    response({
      ...base,
      understood: [
        { kind: 'commitment', itemId: 'unknown-item', text: 'Unknown meeting' },
        { kind: 'consideration', seedItemId: 'seed-1', text: 'Move closer to work' },
      ],
    }),
  );

  const wrongShape = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });
  const brokenInvariant = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });

  expect(wrongShape.proposal).toMatchObject({ proposalId: 'proposal-1', items: [{ itemId: 'item-1', title: 'Meeting' }] });
  expect(wrongShape.proposal?.understood).toBeUndefined();
  expect(wrongShape.proposal?.items[0]?.endTime).toBeUndefined();
  expect(brokenInvariant.proposal).toMatchObject({ proposalId: 'proposal-1', items: [{ itemId: 'item-1', title: 'Meeting' }] });
  expect(brokenInvariant.proposal?.items[0]?.endTime).toBeUndefined();
  expect(brokenInvariant.proposal?.understood).toBeUndefined();
});

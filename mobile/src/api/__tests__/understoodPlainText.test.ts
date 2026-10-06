/**
 * M2A-REV-001: a summary line is plain words. One that links somewhere, holds
 * control characters, is blank, or says something was saved drops the whole
 * summary — through the real client — and the answer still parses.
 */
import { afterEach, beforeEach, expect, it, jest } from '@jest/globals';
import { chatCapture } from '../endpoints/capture';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../auth';

const USER = { uid: 'plain-text-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
const item = { itemId: 'i1', title: 'Meeting', resolvedTime: '2030-01-07T16:00:00.000Z', needsClarification: false };

function answerWith(text: string) {
  return {
    conversationId: 'c1', reply: 'Understood.', engine: 'rules',
    turns: [{ role: 'user', text: 'meeting' }, { role: 'assistant', text: 'Understood.' }],
    proposal: { version: 'v1', proposalId: 'p1', status: 'proposed', items: [item], seeds: [],
      understood: [{ kind: 'commitment', itemId: 'i1', text }] },
  };
}

function serve(body: unknown): void {
  (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({ status: 200, text: async () => JSON.stringify(body) })) as never;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({ initialUser: USER, idToken: 'token' }));
});
afterEach(() => { resetAuthForTests(); jest.restoreAllMocks(); });

it.each([
  ['a link', 'Meeting, details at https://example.com/x'],
  ['a bare domain', 'Meeting on zoom.us.com'],
  ['a control character', 'Meeting\u0007'],
  ['blank words', '   '],
  ['an English saved claim', "I've saved your meeting"],
  ['an Arabic saved claim', 'حفظتلك الاجتماع'],
  ['a Hebrew saved claim', 'שמרתי את הפגישה'],
])('drops a summary with %s, and keeps the answer', async (_label, text) => {
  serve(answerWith(text));
  const answer = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });
  expect(answer.proposal?.items[0]?.title).toBe('Meeting');
  expect(answer.proposal?.understood).toBeUndefined();
});

it('keeps plain words, in any language', async () => {
  serve(answerWith('Zoom مع Dana بكرا'));
  const answer = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });
  expect(answer.proposal?.understood).toHaveLength(1);
});

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
  // M2A-REV-001 round 2: any host, passive claims, and folded spellings.
  ['a host outside the old list', 'Meeting details at example.dev'],
  ['a host with a path', 'Join on zoom.us/j/123'],
  ['a short country host', 'Meet at cafe.de'],
  ['an e-mail address', 'Send it to bob@mail.co'],
  ['a passive English claim', "It's saved to your calendar"],
  ['an "added to your list" claim', 'Dentist added to your list'],
  ['a diacritized Arabic claim', 'حَفَظْتُ الموعد'],
  ['a tatweel-stretched Arabic claim', 'حـفـظت الموعد'],
  ['an Arabic "it was saved"', 'تم الحفظ'],
  ['an Arabic promised reminder', 'رح ذكرك بكرا'],
  ['a Hebrew claim with a joining vav', 'ונשמר ביומן'],
])('drops a summary with %s, and keeps the answer', async (_label, text) => {
  serve(answerWith(text));
  const answer = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });
  expect(answer.proposal?.items[0]?.title).toBe('Meeting');
  expect(answer.proposal?.understood).toBeUndefined();
});

it.each([
  ['words beside a decimal', 'Pay 2.5 dinars for the bus'],
  // M2a combined review F3: file names and honorifics are the person's words.
  ['a file name', 'Check report.pdf before the meeting'],
  ['an honorific glued to a name', 'Read Mr.Smith notes'],
  ['an abbreviation', 'Bring the forms, e.g. the passport'],
  ['an Arabic word that merely contains a claim root', 'محفظة جديدة'],
  ['the person\'s own "save money"', 'Save money for the trip'],
])('keeps %s', async (_label, text) => {
  serve(answerWith(text));
  const answer = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });
  expect(answer.proposal?.understood).toHaveLength(1);
});

it('keeps plain words, in any language', async () => {
  serve(answerWith('Zoom مع Dana بكرا'));
  const answer = await chatCapture({ conversationId: null, message: 'meeting', timezone: 'UTC' });
  expect(answer.proposal?.understood).toHaveLength(1);
});

/** M2B-A-006: mock mode answers structured edits the way the server would, from the request alone. */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mockResponseFor } from '../mockAdapter';
import fixture from '../__fixtures__/capture.chatProposal.json';

const ITEM = (fixture as { proposal: { items: { itemId: string; title: string }[] } }).proposal.items[0]!;
const edit = (change: Record<string, unknown>, target: Record<string, string> = { itemId: ITEM.itemId }) =>
  mockResponseFor('POST', '/api/mobile/capture/chat', { conversationId: 'c', edit: { proposalId: 'p', revision: 1, target, change }, timezone: 'UTC' });

const before = { mode: process.env.EXPO_PUBLIC_API_MODE, env: process.env.EXPO_PUBLIC_APP_ENV };
beforeEach(() => { process.env.EXPO_PUBLIC_API_MODE = 'mock'; process.env.EXPO_PUBLIC_APP_ENV = 'development'; });
afterEach(() => { process.env.EXPO_PUBLIC_API_MODE = before.mode; process.env.EXPO_PUBLIC_APP_ENV = before.env; });

describe('the mock refuses what the server refuses', () => {
  it.each([
    ['an unknown point', () => edit({ text: 'x' }, { itemId: 'nope' })],
    ['words and a correction undo together', () => edit({ text: 'x', rejectCorrectionIds: ['c1'] })],
  ])('%s → 400 edit_invalid', (_label, send) => {
    const response = send();
    expect(response?.status).toBe(400);
    expect(response?.body).toEqual({ reason: 'edit_invalid' });
  });
});

it('a correction id the point does not carry is refused, as the route refuses it', () => {
  const response = edit({ rejectCorrectionIds: ['none-here'] });
  expect(response?.status).toBe(400);
  expect(response?.body).toEqual({ reason: 'edit_invalid' });
});

it('an empty patch and a patch that changes nothing are refused', () => {
  expect(edit({})?.status).toBe(400);
  expect(edit({ text: ITEM.title })?.status).toBe(400);
  expect(edit({ kind: 'commitment' })?.status).toBe(400);
});

it('any revision but the current one is a conflict, a newer one too', () => {
  const send = (revision: number) => mockResponseFor('POST', '/api/mobile/capture/chat', {
    conversationId: 'c', timezone: 'UTC', edit: { proposalId: 'p', revision, target: { itemId: ITEM.itemId }, change: { text: 'x' } },
  });
  expect(send(0)?.status).toBe(409);
  expect(send(2)?.status).toBe(409);
  expect(send(1)?.status).toBe(200);
});

it('a dictated message gets the corrected answer, and undoing its correction puts «الطلع» back', () => {
  const spoken = mockResponseFor('POST', '/api/mobile/capture/chat', { message: 'الطلع عالسوق', spoken: true, timezone: 'UTC' });
  const item = (spoken?.body as { proposal: { items: { itemId: string; title: string; corrections: { id: string }[] }[] } }).proposal.items[0]!;
  expect(item.corrections).toHaveLength(1);
  const undone = mockResponseFor('POST', '/api/mobile/capture/chat', {
    conversationId: 'c', timezone: 'UTC',
    edit: { proposalId: 'p', revision: 1, target: { itemId: item.itemId }, change: { rejectCorrectionIds: [item.corrections[0]!.id] } },
  });
  const after = (undone?.body as { proposal: { items: { title: string; corrections?: unknown }[]; understood?: { text: string }[] } }).proposal;
  expect(after.items[0]!.title).toContain('الطلع'); // «الطلع»
  expect(after.items[0]!.corrections).toBeUndefined();
});

it('an edit adds the route\'s two turns, in its words, after the conversation so far', () => {
  // The route's answer to a kind edit (capture.chatEditKind) ends with these two turns.
  const route = require('../__fixtures__/capture.chatEditKind.json') as { reply: string; turns: { role: string; text: string }[] };
  const turnsBefore = (fixture as { turns: unknown[] }).turns.length;
  const response = edit({ kind: 'idea' });
  const body = response?.body as { reply: string; turns: { role: string; text: string }[] };
  expect(body.reply).toBe(route.reply);
  expect(body.turns).toHaveLength(turnsBefore + 2);
  expect(body.turns.slice(-2)).toEqual([
    { role: 'user', text: `غيّر نوع «${ITEM.title}».`, evidence: false },
    { role: 'assistant', text: route.turns[route.turns.length - 1]!.text },
  ]);
  const words = edit({ text: 'Call Sami' })?.body as { turns: { text: string }[] };
  expect(words.turns[words.turns.length - 2]!.text).toBe(`غيّر «${ITEM.title}» لـ «${'Call Sami'}».`);
});

it('the answer is normalized as the route normalizes it: status follows the kind, a new time brings its own day', () => {
  const idea = edit({ kind: 'idea' })?.body as { proposal: { status: string; items: unknown[] } };
  expect(idea.proposal.items).toHaveLength(0);
  expect(idea.proposal.status).toBe('unresolved_intent');
  const moved = edit({ time: { at: '2031-03-04T22:30:00.000Z', timeZone: 'Asia/Jerusalem' } })?.body as { proposal: { status: string; items: Record<string, unknown>[] } };
  const item = moved.proposal.items[0]!;
  expect(item.resolvedDate).toBe('2031-03-05');
  expect(item.dateEstimated).toBe(false);
  expect(item.timeEstimated).toBe(false);
  expect(item.weeklyBlock).toBeUndefined();
  expect(item.clarification).toBeNull();
  expect(moved.proposal.status).toBe('proposed');
});

it('a restore names nothing removed in mock mode, so it is refused as the route refuses it', () => {
  expect(edit({ restore: true })?.status).toBe(400);
  expect(edit({ restore: true, text: 'x' })?.status).toBe(400);
});

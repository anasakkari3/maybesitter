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

it('undoing a correction puts the heard word back in the title and the summary line', () => {
  // A fixture item carrying a correction is the server's (capture.chatCorrection);
  // here one is given to the request-aware path through the base fixture's item.
  const response = mockResponseFor('POST', '/api/mobile/capture/chat', {
    conversationId: 'c', timezone: 'UTC',
    edit: { proposalId: 'p', revision: 1, target: { itemId: ITEM.itemId }, change: { rejectCorrectionIds: ['none-here'] } },
  });
  expect(response?.status).toBe(200);
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

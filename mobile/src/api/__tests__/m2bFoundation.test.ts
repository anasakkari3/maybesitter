/**
 * M2b contract foundation (CONTRACT v4): tolerant `revision` and `corrections`
 * on a proposal, and the 409 `proposal_changed` read through the real client
 * in both of its shapes.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { captureProposalSchema } from '../schemas/capture';
import { apiRequest } from '../client';
import { captureChatSchema } from '../schemas/capture';
import { ContractError, ProposalChangedError } from '../errors';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../auth';

const item = { itemId: 'i1', title: 'اطلع عالسوق', resolvedTime: '2030-01-07T16:00:00.000Z', needsClarification: false };
const base = { version: 'v1', proposalId: 'p1', status: 'proposed', items: [item], seeds: [] };

describe('revision', () => {
  it('keeps a non-negative integer and reads anything else as absent', () => {
    expect(captureProposalSchema.parse({ ...base, revision: 3 }).revision).toBe(3);
    for (const revision of [-1, 1.5, '2', null]) {
      const parsed = captureProposalSchema.parse({ ...base, revision });
      expect(parsed.revision).toBeUndefined();
      expect(parsed.items).toHaveLength(1);
    }
    expect(captureProposalSchema.parse(base).revision).toBeUndefined();
  });
});

describe('corrections', () => {
  const good = [{ id: 'c1', from: 'الطلع', to: 'اطلع' }];
  it('keeps well-formed corrections', () => {
    expect(captureProposalSchema.parse({ ...base, items: [{ ...item, corrections: good }] }).items[0]!.corrections).toEqual(good);
  });
  it.each([
    ['not a list', 'الطلع'],
    ['a blank part', [{ id: 'c1', from: '', to: 'اطلع' }]],
    ['two words', [{ id: 'c1', from: 'الطلع بكرا', to: 'اطلع' }]],
    ['a repeated id', [{ id: 'c1', from: 'a', to: 'b' }, { id: 'c1', from: 'c', to: 'd' }]],
    ['more than three', [1, 2, 3, 4].map((n) => ({ id: `c${n}`, from: 'a', to: 'b' }))],
    ['an extra field', [{ id: 'c1', from: 'a', to: 'b', at: 3 }]],
  ])('reads %s as absent, and the item still parses', (_label, corrections) => {
    const parsed = captureProposalSchema.parse({ ...base, items: [{ ...item, corrections }] });
    expect(parsed.items[0]!.corrections).toBeUndefined();
    expect(parsed.items[0]!.title).toBe('اطلع عالسوق');
  });
});

describe('409 proposal_changed through the client', () => {
  const USER = { uid: 'm2b-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] };
  function serve(status: number, body: unknown): void {
    (globalThis as { fetch: unknown }).fetch = jest.fn(async () => ({ status, text: async () => JSON.stringify(body) })) as never;
  }
  beforeEach(() => {
    process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
    setAuthRepository(createFakeAuthRepository({ initialUser: USER, idToken: 'token' }));
  });
  afterEach(() => { resetAuthForTests(); jest.restoreAllMocks(); });

  const answer = { conversationId: 'c1', reply: 'ok', engine: 'rules', turns: [], proposal: { ...base, revision: 2 } };

  it('carries the current chat answer for a structured edit', async () => {
    serve(409, { reason: 'proposal_changed', answer });
    const error = await apiRequest('POST', '/api/mobile/capture/chat', { body: {}, schema: captureChatSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProposalChangedError);
    const current = (error as ProposalChangedError).current;
    expect(current.kind).toBe('chat');
    expect(current.kind === 'chat' && current.answer.proposal?.revision).toBe(2);
  });

  it('carries the current proposal and its state for confirm, clarify and keep', async () => {
    serve(409, { reason: 'proposal_changed', proposal: { ...base, revision: 4 }, state: 'confirmed' });
    const error = await apiRequest('POST', '/api/mobile/capture/confirm', { body: {}, schema: captureChatSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProposalChangedError);
    const current = (error as ProposalChangedError).current;
    expect(current.kind === 'proposal' && [current.state, current.proposal.revision]).toEqual(['confirmed', 4]);
  });

  it('is a contract failure when the current version cannot be read', async () => {
    serve(409, { reason: 'proposal_changed', proposal: { nope: true }, state: 'open' });
    const error = await apiRequest('POST', '/api/mobile/capture/confirm', { body: {}, schema: captureChatSchema }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContractError);
  });
});

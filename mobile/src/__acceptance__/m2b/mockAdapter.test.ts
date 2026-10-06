import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mockResponseFor } from '../../api/mockAdapter';
import { captureChatSchema, type CaptureChatAnswer } from '../../api/schemas/capture';

const ORIGINAL_MODE = process.env.EXPO_PUBLIC_API_MODE;
const ORIGINAL_ENV = process.env.EXPO_PUBLIC_APP_ENV;
const ITEM_ID = '00000000-0000-4000-8000-000000000003';
const BASE = {
  conversationId: '00000000-0000-4000-8000-000000000001',
  edit: {
    proposalId: '00000000-0000-4000-8000-000000000002',
    revision: 1,
    target: { itemId: ITEM_ID },
  },
  timezone: 'UTC',
  referenceTime: '2030-01-01T00:00:00.000Z',
};

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_MODE = 'mock';
  process.env.EXPO_PUBLIC_APP_ENV = 'development';
});

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.EXPO_PUBLIC_API_MODE;
  else process.env.EXPO_PUBLIC_API_MODE = ORIGINAL_MODE;
  if (ORIGINAL_ENV === undefined) delete process.env.EXPO_PUBLIC_APP_ENV;
  else process.env.EXPO_PUBLIC_APP_ENV = ORIGINAL_ENV;
});

function answer(change: Record<string, unknown>): { status: number; answer: CaptureChatAnswer } {
  const response = mockResponseFor('POST', '/api/mobile/capture/chat', {
    ...BASE,
    edit: { ...BASE.edit, change },
  });
  expect(response).not.toBeNull();
  return { status: response!.status, answer: captureChatSchema.parse(response!.body) };
}

describe('M2b request-aware chat mock', () => {
  it('A5b mock kind fixture: a kind patch reaches a revisioned answer whose target moved shape', () => {
    const response = answer({ kind: 'idea' });
    expect(response.status).toBe(200);
    expect(response.answer.proposal?.revision).toBeGreaterThan(BASE.edit.revision);
    expect(response.answer.proposal?.seeds.some((seed) => seed.kind === 'idea')).toBe(true);
  });

  it('A5b mock words fixture: a text patch reaches a revisioned answer with words different from the ordinary message fixture', () => {
    const ordinary = captureChatSchema.parse(mockResponseFor('POST', '/api/mobile/capture/chat', {
      message: 'ordinary', timezone: 'UTC', referenceTime: BASE.referenceTime,
    })!.body);
    const response = answer({ text: 'Edited fixture words' });
    expect(response.status).toBe(200);
    expect(response.answer.proposal?.revision).toBeGreaterThan(BASE.edit.revision);
    expect(response.answer.proposal?.items[0]?.title).not.toBe(ordinary.proposal?.items[0]?.title);
  });

  it('A5b mock time fixture: an absolute time patch reaches a revisioned answer with a changed instant', () => {
    const ordinary = captureChatSchema.parse(mockResponseFor('POST', '/api/mobile/capture/chat', {
      message: 'ordinary', timezone: 'UTC', referenceTime: BASE.referenceTime,
    })!.body);
    const response = answer({ time: { at: '2030-01-08T18:00:00.000Z', timeZone: 'UTC' } });
    expect(response.status).toBe(200);
    expect(response.answer.proposal?.revision).toBeGreaterThan(BASE.edit.revision);
    expect(response.answer.proposal?.items[0]?.resolvedTime).not.toBe(ordinary.proposal?.items[0]?.resolvedTime);
  });

  it('A5b mock correction fixture: rejectCorrectionIds reaches its own revisioned answer rather than the message fixture', () => {
    const ordinary = mockResponseFor('POST', '/api/mobile/capture/chat', {
      message: 'ordinary', timezone: 'UTC', referenceTime: BASE.referenceTime,
    });
    const response = mockResponseFor('POST', '/api/mobile/capture/chat', {
      ...BASE,
      edit: { ...BASE.edit, change: { rejectCorrectionIds: ['correction-1'] } },
    });
    expect(response?.status).toBe(200);
    const parsed = captureChatSchema.parse(response?.body);
    expect(parsed.proposal?.revision).toBeGreaterThan(BASE.edit.revision);
    expect(response?.body).not.toEqual(ordinary?.body);
  });

  it('A5b mock stale fixture: a stale revision reaches the 409 proposal_changed response', () => {
    const response = mockResponseFor('POST', '/api/mobile/capture/chat', {
      ...BASE,
      edit: { ...BASE.edit, revision: 0, change: { text: 'Stale words' } },
    });
    expect(response?.status).toBe(409);
    expect(response?.body).toEqual(expect.objectContaining({ reason: 'proposal_changed', answer: expect.any(Object) }));
  });
});

/**
 * Weekly fixed blocks («ثابت أسبوعي») — the phone's calls, read against the
 * route-generated fixtures.
 *
 *   - a refusal keeps the contract's `code` (`overnight_not_supported` has to
 *     be said in the person's language), and only on the weekly routes;
 *   - a create carries `confirmation.confirmedByUserAt` and expects 201;
 *   - the capture confirm names `weeklyBlockItemIds` only when there are some,
 *     and the idempotency intent changes when the weekly choice does.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { apiRequest } from '../client';
import { confirmCapture } from '../endpoints/capture';
import {
  createWeeklyBlock,
  deleteWeeklyBlock,
  listWeeklyBlockOccurrences,
  listWeeklyBlocks,
  patchWeeklyBlock,
} from '../endpoints/weeklyBlocks';
import { ConfirmationRequiredError, ValidationError, WeeklyBlockRefusedError } from '../errors';
import { confirmIntent } from '../queries';
import { createFakeAuthRepository } from '../../auth/fakeAuthRepository';
import { resetAuthForTests, setAuthRepository } from '../auth';
import { z } from 'zod';
import overnightRefused from '../__fixtures__/weeklyBlocks.overnightRefused.json';
import created from '../__fixtures__/weeklyBlocks.created.json';
import list from '../__fixtures__/weeklyBlocks.list.json';
import occurrences from '../__fixtures__/weeklyBlocks.occurrences.json';
import paused from '../__fixtures__/weeklyBlocks.paused.json';
import deleted from '../__fixtures__/weeklyBlocks.deleted.json';
import weeklyConfirmation from '../__fixtures__/capture.weeklyBlockConfirmation.json';

type Call = { url: string; init: { method: string; body?: string } };
let calls: Call[] = [];

function serve(body: unknown, status: number): void {
  calls = [];
  (globalThis as { fetch: unknown }).fetch = jest.fn(async (url: string, init: Call['init']) => {
    calls.push({ url, init });
    return { status, text: async () => JSON.stringify(body), headers: { get: () => null } };
  }) as never;
}

function sentBody(): Record<string, unknown> {
  return JSON.parse(calls[0]!.init.body ?? 'null') as Record<string, unknown>;
}

beforeEach(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = 'http://localhost:3000';
  setAuthRepository(createFakeAuthRepository({
    initialUser: { uid: 'weekly-user', email: null, emailVerified: true, displayName: null, providerIds: ['password'] },
  }));
});

afterEach(() => {
  resetAuthForTests();
  jest.restoreAllMocks();
});

describe('refusals', () => {
  it('keeps the overnight code from the route\'s own body', async () => {
    serve(overnightRefused, 400);
    const error = await createWeeklyBlock({
      title: 'Night shift', weekdays: [5], start: '22:00', end: '06:00', timezone: 'Asia/Jerusalem', confirmedByUserAt: '2026-09-29T10:00:00.000Z',
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeeklyBlockRefusedError);
    expect((error as WeeklyBlockRefusedError).code).toBe('overnight_not_supported');
  });

  it('does not read a weekly `confirmation_required` as the account deletion\'s re-auth', async () => {
    serve({ success: false, error: 'confirm it', code: 'confirmation_required' }, 400);
    const error = await patchWeeklyBlock('b1', { status: 'paused' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WeeklyBlockRefusedError);
    expect(error).not.toBeInstanceOf(ConfirmationRequiredError);
  });

  it('leaves a `code` on any other route to the generic classes', async () => {
    serve({ success: false, error: 'nope', code: 'overnight_not_supported' }, 400);
    const error = await apiRequest('POST', '/api/mobile/habits', { body: {}, schema: z.object({}).passthrough() })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).not.toBeInstanceOf(WeeklyBlockRefusedError);
  });
});

describe('the calls', () => {
  it('creates with the person\'s confirmation and expects 201', async () => {
    serve(created, 201);
    const block = await createWeeklyBlock({
      title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem', confirmedByUserAt: '2026-09-29T10:00:00.000Z',
    });
    expect(block.id).toBe(created.block.id);
    expect(calls[0]!.init.method).toBe('POST');
    expect(sentBody()).toEqual({
      title: 'تدريب', weekdays: [6], start: '10:00', end: '16:00', timezone: 'Asia/Jerusalem',
      confirmation: { confirmedByUserAt: '2026-09-29T10:00:00.000Z' },
    });
  });

  it('refuses a 200 on create: the route says 201 when it made one', async () => {
    serve(created, 200);
    await expect(createWeeklyBlock({
      title: 'x', weekdays: [1], start: '10:00', end: '11:00', timezone: 'UTC', confirmedByUserAt: '2026-09-29T10:00:00.000Z',
    })).rejects.toBeTruthy();
  });

  it('lists, patches, deletes and reads occurrences on their own paths', async () => {
    serve(list, 200);
    expect((await listWeeklyBlocks()).map((block) => block.title)).toEqual(['تدريب', 'دوام']);
    expect(calls[0]!.url).toBe('http://localhost:3000/api/mobile/weekly-blocks');

    serve(paused, 200);
    await patchWeeklyBlock('b 1', { status: 'paused' });
    expect(calls[0]!.url).toBe('http://localhost:3000/api/mobile/weekly-blocks/b%201');
    expect(calls[0]!.init.method).toBe('PATCH');
    expect(sentBody()).toEqual({ status: 'paused' });

    serve(deleted, 200);
    await deleteWeeklyBlock('b1');
    expect(calls[0]!.init.method).toBe('DELETE');

    serve(occurrences, 200);
    const items = await listWeeklyBlockOccurrences({ from: '2026-09-27T21:00:00.000Z', to: '2026-10-04T21:00:00.000Z' });
    expect(items).toHaveLength(2);
    expect(calls[0]!.url).toContain('/api/mobile/weekly-blocks/occurrences?');
    expect(calls[0]!.url).toContain('from=2026-09-27T21%3A00%3A00.000Z');
    expect(calls[0]!.url).toContain('to=2026-10-04T21%3A00%3A00.000Z');
  });
});

describe('the capture confirm', () => {
  it('names the weekly items when there are some', async () => {
    serve(weeklyConfirmation, 200);
    const result = await confirmCapture({ proposalId: 'p1', itemIds: ['i1', 'i2'], weeklyBlockItemIds: ['i1'] });
    expect(sentBody().weeklyBlockItemIds).toEqual(['i1']);
    expect(result.weeklyBlocks?.[0]?.block.title).toBe('تدريب');
  });

  it('sends no weekly field at all for a one-off confirm', async () => {
    serve(weeklyConfirmation, 200);
    await confirmCapture({ proposalId: 'p1', itemIds: ['i1'], weeklyBlockItemIds: [] });
    expect(sentBody()).not.toHaveProperty('weeklyBlockItemIds');
  });

  it('treats weekly-or-once as part of what the confirm means', () => {
    const once = confirmIntent({ proposalId: 'p1', itemIds: ['i1'] });
    const weekly = confirmIntent({ proposalId: 'p1', itemIds: ['i1'], weeklyBlockItemIds: ['i1'] });
    expect(weekly).not.toBe(once);
    // An empty choice is the confirm an older app sends, key and all.
    expect(confirmIntent({ proposalId: 'p1', itemIds: ['i1'], weeklyBlockItemIds: [] })).toBe(once);
  });
});

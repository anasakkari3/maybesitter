import { apiRequest } from '../client';
import {
  weeklyBlockChangedSchema,
  weeklyBlockDeletedSchema,
  weeklyBlockListSchema,
  weeklyBlockOccurrencesSchema,
  type WeeklyBlock,
  type WeeklyBlockOccurrence,
} from '../schemas/weeklyBlocks';

/**
 * Weekly fixed blocks — «ثابت أسبوعي» (server: `src/app/api/mobile/weekly-blocks`).
 *
 * A refusal answers `{ success: false, error, code }` and `client.ts` turns it
 * into a `WeeklyBlockRefusedError` carrying the code, so a screen can say
 * `overnight_not_supported` in the person's language.
 */

/** Every block the account keeps, paused ones included. */
export async function listWeeklyBlocks(): Promise<WeeklyBlock[]> {
  const result = await apiRequest('GET', '/api/mobile/weekly-blocks', { schema: weeklyBlockListSchema });
  return result.items;
}

export interface NewWeeklyBlock {
  title: string;
  weekdays: number[];
  start: string;
  end: string;
  timezone: string;
  /**
   * When the person pressed the button that says "keep this every week". The
   * server refuses a block without it and never fills one in: a block exists
   * only because somebody said yes to it.
   */
  confirmedByUserAt: string;
}

export async function createWeeklyBlock(input: NewWeeklyBlock): Promise<WeeklyBlock> {
  const result = await apiRequest('POST', '/api/mobile/weekly-blocks', {
    body: {
      title: input.title,
      weekdays: input.weekdays,
      start: input.start,
      end: input.end,
      timezone: input.timezone,
      confirmation: { confirmedByUserAt: input.confirmedByUserAt },
    },
    expectStatus: 201,
    schema: weeklyBlockChangedSchema,
  });
  return result.block;
}

/** Title, days, hours or status. Editing is not re-confirming: no confirmation here. */
export interface WeeklyBlockPatch {
  title?: string;
  weekdays?: number[];
  start?: string;
  end?: string;
  status?: 'active' | 'paused';
}

export async function patchWeeklyBlock(id: string, patch: WeeklyBlockPatch): Promise<WeeklyBlock> {
  const result = await apiRequest('PATCH', `/api/mobile/weekly-blocks/${encodeURIComponent(id)}`, {
    body: patch,
    schema: weeklyBlockChangedSchema,
  });
  return result.block;
}

export async function deleteWeeklyBlock(id: string): Promise<void> {
  await apiRequest('DELETE', `/api/mobile/weekly-blocks/${encodeURIComponent(id)}`, {
    schema: weeklyBlockDeletedSchema,
  });
}

/** Occurrences in `[from, to)` — ISO instants, at most 62 days apart. */
export async function listWeeklyBlockOccurrences(range: { from: string; to: string }): Promise<WeeklyBlockOccurrence[]> {
  const result = await apiRequest('GET', '/api/mobile/weekly-blocks/occurrences', {
    query: { from: range.from, to: range.to },
    schema: weeklyBlockOccurrencesSchema,
  });
  return result.items;
}

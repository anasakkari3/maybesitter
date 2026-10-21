import { z } from 'zod';
import { commitmentSchema } from './common';

/**
 * M6a-1's shapes (PLAN-M6a Wire, after the r5 amendments): the capability
 * probe and the commitment search. New objects are strict.
 */
export const m6CapabilitiesSchema = z.object({
  success: z.literal(true),
  searchHistory: z.boolean(),
  /**
   * M6a-2: «اكتبها بالعربي», a proposed translation of one stored fact.
   * Optional so an app newer than its server keeps the search it already has:
   * absent reads as off.
   */
  memoryTranslation: z.boolean().optional(),
}).strict();
export type M6Capabilities = z.infer<typeof m6CapabilitiesSchema>;

/** `POST /api/mobile/commitments/search` (R5-001): the commitment DTO, which carries `status`. */
export const commitmentSearchSchema = z.object({
  success: z.literal(true),
  items: z.array(commitmentSchema),
  truncated: z.boolean(),
}).strict();
export type CommitmentSearch = z.infer<typeof commitmentSearchSchema>;

/**
 * `POST /api/mobile/memory/{id}/translation` (PLAN-M6a-2 R1): a proposal or
 * nothing. Nothing is stored until the person saves it through the ordinary
 * edit, against the same `memoryId`.
 */
export const memoryTranslationSchema = z.object({
  success: z.literal(true),
  proposal: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('ready'),
      text: z.string().min(1).max(200),
      from: z.enum(['ar', 'en', 'he', 'mixed']),
      to: z.enum(['ar', 'en', 'he']),
      memoryId: z.string().min(1),
    }).strict(),
    z.object({ status: z.literal('unavailable') }).strict(),
  ]),
}).strict();
export type MemoryTranslation = z.infer<typeof memoryTranslationSchema>;

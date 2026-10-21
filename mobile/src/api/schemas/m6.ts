import { z } from 'zod';
import { commitmentSchema } from './common';

/**
 * M6a-1's shapes (PLAN-M6a Wire, after the r5 amendments): the capability
 * probe and the commitment search. New objects are strict.
 */
export const m6CapabilitiesSchema = z.object({
  success: z.literal(true),
  searchHistory: z.boolean(),
}).strict();
export type M6Capabilities = z.infer<typeof m6CapabilitiesSchema>;

/**
 * M6a-2's own probe (M6A2-R3-001). `/capabilities/m6` stays exactly as
 * installed apps parse it — strict, two keys — so the translation switch lives
 * on a route of its own; a server that predates it answers 404, read as off.
 */
export const m6bCapabilitiesSchema = z.object({
  success: z.literal(true),
  memoryTranslation: z.boolean(),
  /** The disclosure the server will accept; the app offers the action only for one it has copy for (M6A2-R4-002). */
  disclosureVersion: z.string().min(1),
}).strict();
export type M6bCapabilities = z.infer<typeof m6bCapabilitiesSchema>;

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
      // The detected language of the row's text; `other` and letterless rows are refused before this.
      from: z.enum(['ar', 'en', 'he']),
      to: z.enum(['ar', 'en', 'he']),
      memoryId: z.string().min(1),
    }).strict(),
    z.object({ status: z.literal('unavailable') }).strict(),
  ]),
}).strict();
export type MemoryTranslation = z.infer<typeof memoryTranslationSchema>;

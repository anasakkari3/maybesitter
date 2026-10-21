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

/** `POST /api/mobile/commitments/search` (R5-001): the commitment DTO, which carries `status`. */
export const commitmentSearchSchema = z.object({
  success: z.literal(true),
  items: z.array(commitmentSchema),
  truncated: z.boolean(),
}).strict();
export type CommitmentSearch = z.infer<typeof commitmentSearchSchema>;

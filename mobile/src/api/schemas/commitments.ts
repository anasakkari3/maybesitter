import { z } from 'zod';
import { commitmentSchema } from './common';

export const commitmentActionResultSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  commitment: commitmentSchema,
});

/**
 * Mirrors `commitments.deleted.json`. `deleted: false, softDeleted: true` is
 * the honest answer: DELETE drops the commitment, it does not erase it. The
 * field names say so rather than letting the verb imply otherwise.
 */
export const commitmentDeleteResultSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  deleted: z.boolean(),
  softDeleted: z.boolean(),
  status: z.string(),
});

import { z } from 'zod';

/**
 * Which categories this account uses, and whether its lists are split (#415).
 *
 * `enabled` is a list rather than a set of booleans because the server owns its
 * order — the catalog order — and a client that rebuilt the order from its own
 * object keys would draw the chips differently on a different JS engine.
 */
export const categoryPreferencesSchema = z.object({
  enabled: z.array(z.enum(['work', 'family', 'health', 'finance', 'social', 'errands'])),
  grouping: z.boolean(),
});

export const categoryPreferencesResponseSchema = z.object({
  success: z.literal(true),
  categoryPreferences: categoryPreferencesSchema,
});

export type CategoryPreferences = z.infer<typeof categoryPreferencesSchema>;

import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * Things the person is considering or waiting on (#519).
 *
 * A Seed is deliberately none of the other three: not a commitment, not a
 * memory fact, not a goal. Nothing here has a priority, a time or a rank,
 * because nothing about a seed enters Priority, the Daily Plan or reminders —
 * and the absence of those fields is the contract saying so rather than the
 * screen remembering to.
 */
export const seedKindSchema = z.enum(['consideration', 'waiting_for', 'idea', 'possible_goal']);

/**
 * The statuses the app can be shown.
 *
 * `expired` is in the server's union and nothing sets it; it is here so a
 * build that one day does cannot make this schema reject the row. `promoted`
 * is terminal and is written only by the promote route — never by a patch,
 * which is what stops a seed from promoting itself.
 */
export const seedStatusSchema = z.enum([
  'open', 'snoozed', 'waiting', 'promoted', 'dismissed', 'expired',
]);

export const seedSchema = z.object({
  version: z.string(),
  seedId: z.string(),
  scopeId: z.string(),
  kind: seedKindSchema,
  /** The person's own sentence, verbatim. Never a paraphrase. */
  summary: z.string(),
  status: seedStatusSchema,
  /** Their own "ask me again" marker, and never a due time. */
  revisitAt: isoDateTime.nullable(),
  source: z.enum(['capture', 'manual', 'share']),
  sourceRef: z.string().nullable(),
  provenance: z.object({
    proposalId: z.string().nullable(),
    extractor: z.string().nullable(),
    confirmedByUserAt: isoDateTime,
  }),
  promotedTo: z.object({ kind: z.enum(['commitment', 'goal']), id: z.string() }).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export type Seed = z.infer<typeof seedSchema>;
export type SeedKind = z.infer<typeof seedKindSchema>;
export type SeedStatus = z.infer<typeof seedStatusSchema>;

export const seedListSchema = z.object({ items: z.array(seedSchema) });

/**
 * `replayed` is the second tap (#519). The server answers 200 with the seed it
 * already made rather than 201 with a twin, and the screen reads it as the
 * same success — which is what makes Keep safe to press on a flaky connection.
 */
export const seedSavedSchema = z.object({
  success: z.literal(true),
  replayed: z.boolean().optional(),
  seed: seedSchema,
});

export const seedDeletedSchema = z.object({ success: z.literal(true), deleted: z.number() });

import { z } from 'zod';
import { commitmentSchema } from './common';

/**
 * 409 `stale_commitment` (#148) — another device changed this commitment.
 *
 * `current` is the whole commitment as it actually is, which is what makes
 * "somebody else changed this, here it is" possible instead of "your edit was
 * refused". Note there is **no `error` field**: these refusals carry `reason`
 * only, so `errorBodySchema` does not describe them.
 */
export const staleCommitmentSchema = z.object({
  success: z.literal(false),
  reason: z.literal('stale_commitment'),
  current: commitmentSchema,
});

/** 409 `invalid_transition` — the move was impossible. No payload. */
export const invalidTransitionSchema = z.object({
  success: z.literal(false),
  reason: z.literal('invalid_transition'),
});

export const commitmentActionResultSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  commitment: commitmentSchema,
  /** A repeated `clientActionId` (#200): applied earlier, not again. */
  replayed: z.literal(true).optional(),
});

/**
 * Mirrors `commitments.deleted.json`. DELETE hides the commitment from every
 * screen (`status: 'archived'`, CA2.3) and is never a drop; `deleted: false,
 * softDeleted: true` is the honest answer that the record is kept, not erased.
 */
export const commitmentDeleteResultSchema = z.object({
  success: z.boolean(),
  id: z.string(),
  deleted: z.boolean(),
  softDeleted: z.boolean(),
  status: z.string(),
});

/**
 * «ما اتصرّفت فيها» (lane E2): appointments that are over and deadlines that
 * passed, still open. Mirrors `commitments.unhandled.json`. `since` is when it
 * ended or when the deadline passed; `askCount` is how often capture asked.
 */
export const unhandledItemSchema = z.object({
  reason: z.enum(['event_ended', 'deadline_passed']),
  since: z.string(),
  /** The instant whose day to name: an all-day item's own day, not the midnight after it. Absent from an older server: read `since`. */
  shownAt: z.string().optional(),
  askCount: z.number().int().nonnegative(),
  commitment: commitmentSchema,
});

export const unhandledListSchema = z.object({
  items: z.array(unhandledItemSchema),
});

export type UnhandledItem = z.infer<typeof unhandledItemSchema>;

/** «لا تسألني عنها». A repeat of the same press answers `replayed: true`. */
export const unhandledDismissResultSchema = z.object({
  success: z.literal(true),
  id: z.string(),
  dismissed: z.literal(true),
  replayed: z.literal(true).optional(),
});

/** 409: the item is not in the place (settled, moved ahead, or a task). No `error` field. */
export const notUnhandledSchema = z.object({
  success: z.literal(false),
  reason: z.literal('not_unhandled'),
});

import { z } from 'zod';
import { isoDateTime } from './common';

/**
 * The deletion receipt (UC-1.5 #149).
 *
 * The proof the user is owed, and deliberately the *only* thing that comes
 * back: no uid, no email, no name. `lib/account/accountDeletion.ts` keeps
 * `subjectHash` server-side and the route does not send it, so there is
 * nothing here to leak or to have to delete later.
 *
 * `steps` is open-ended on purpose. The server owns the step list
 * (`DELETION_STEPS`), and a client that refused an unfamiliar step name would
 * break the moment a step is added — while the thing the user needs, the
 * receipt id, would still have arrived.
 */
export const deletionStepOutcomeSchema = z.enum(['done', 'failed', 'skipped']);

export const deletionReceiptSchema = z.object({
  receiptId: z.string().min(1),
  deletedAt: isoDateTime,
  steps: z.record(z.string(), deletionStepOutcomeSchema),
});

export const accountDeletionResponseSchema = z.object({
  success: z.literal(true),
  receipt: deletionReceiptSchema,
});

export type DeletionReceipt = z.infer<typeof deletionReceiptSchema>;
export type DeletionStepOutcome = z.infer<typeof deletionStepOutcomeSchema>;

/** The exact string the route requires. Not a flag the UI can default. */
export const DELETION_CONFIRMATION = 'delete-my-account';

import { z } from 'zod';
import { isoDateTime } from './common';

/** Mirrors `capture.proposal.json`. A proposal never implies persistence. */
export const captureProposalSchema = z.object({
  version: z.string(),
  proposalId: z.string(),
  status: z.enum(['proposed', 'needs_clarification', 'no_commitment', 'rejected']),
  /**
   * Why nothing was created, on a `no_commitment` proposal (UC-2.6, #166).
   *
   * A reason code, never a reading of what the person wrote. The client maps it
   * to one fixed neutral line; it does not compose a sentence about it, and
   * there is deliberately no therapeutic or emotional interpretation anywhere in
   * that mapping — «حسّيت بضغط» is `informational` because nothing was asked
   * for, not because the product has an opinion about how somebody feels.
   */
  noCommitmentReason: z
    .enum(['informational', 'greeting_or_chat', 'question', 'past_event', 'negated_request', 'low_confidence'])
    .optional(),
  items: z.array(
    z.object({
      itemId: z.string(),
      title: z.string(),
      resolvedTime: isoDateTime.nullable(),
      needsClarification: z.boolean(),
    }),
  ),
  provenance: z
    .object({
      requestedEngine: z.enum(['model', 'rules']),
      executedEngine: z.string(),
      fallbackUsed: z.boolean(),
    })
    .optional(),
});

export type CaptureProposal = z.infer<typeof captureProposalSchema>;
export type CaptureProposalItem = CaptureProposal['items'][number];

/**
 * Mirrors `capture.confirmation.json` **and** `capture.confirmationFailed.json`.
 *
 * Both shapes are the same object; `success` is what separates them. Since
 * #252 a confirm that persisted nothing also answers 404 or 400 rather than
 * 200, so the client learns of the failure from the status *and* the body —
 * and `failed[]` still names which item was refused and why, which a bare
 * error code would have thrown away.
 */
export const captureConfirmationSchema = z.object({
  success: z.boolean(),
  replayed: z.boolean(),
  persisted: z.array(
    z.object({
      itemId: z.string(),
      commitmentId: z.string(),
      title: z.string(),
      resolvedTime: isoDateTime.nullable(),
    }),
  ),
  failed: z.array(z.object({ itemId: z.string(), reason: z.string() })),
  failureCode: z
    .enum(['proposal_not_found', 'proposal_rejected', 'invalid_selection', 'persistence_failed'])
    .optional(),
});

export type CaptureConfirmation = z.infer<typeof captureConfirmationSchema>;

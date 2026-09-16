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
      /** What the extractor read the importance as: Must / Should / Nice (#164). */
      priority: z.enum(['low', 'normal', 'high']).optional(),
      /**
       * True when that level is the extractor's guess rather than something the
       * person said. The review screen marks it, because a guess presented as a
       * fact is how a product loses the right to make guesses.
       */
      priorityEstimated: z.boolean().optional(),
      /**
       * The one question to ask about this item (UC-2.5, #165).
       *
       * Keys and parameters, never a sentence: the phone renders the question
       * from its own locale files, so the text is never model-generated. An
       * unrecognised `questionKey` means a newer server — the app opens #164's
       * edit sheet rather than rendering something it cannot read.
       *
       * Null with `needsClarification` still true means the one round is spent,
       * and the fallback is the same edit sheet.
       */
      clarification: z
        .object({
          questionId: z.string(),
          field: z.enum(['time', 'action', 'time_period', 'which_day']),
          questionKey: z.string(),
          params: z.record(z.string(), z.string()),
          options: z.array(
            z.object({
              optionId: z.string(),
              labelKey: z.string(),
              labelParams: z.record(z.string(), z.string()),
              value: z.object({ localTime: z.string().optional(), localDate: z.string().optional() }),
            }),
          ),
          allowFreeText: z.boolean(),
        })
        .nullable()
        .optional(),
    }),
  ),
  provenance: z
    .object({
      requestedEngine: z.enum(['model', 'rules']),
      // The three the contract declares (src/contracts/v1/captureContracts.ts:167),
      // not `z.string()`. UC-2.0 (#160) asks the app to fail on an engine it does
      // not know about; a bare string accepts one silently, which is the same
      // shape of defect as a test that cannot go red.
      executedEngine: z.enum(['gemini', 'ollama', 'rule-based']),
      fallbackUsed: z.boolean(),
    })
    .optional(),
});

export type CaptureProposal = z.infer<typeof captureProposalSchema>;
export type CaptureProposalItem = CaptureProposal['items'][number];

/**
 * What a newly-persisted commitment landed on top of (#football-fixtures
 * task 10). No `origin` field: an earlier task carried one and it was
 * withdrawn, because a sealed annotation corpus checksums the whole
 * serialised commitment and the field moved it. A screen that needs to know a
 * colliding commitment came from a synced feed reads that off the commitment
 * itself, not off this warning.
 */
export const collisionWarningSchema = z.object({
  commitmentId: z.string(),
  title: z.string(),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
});

export type CollisionWarning = z.infer<typeof collisionWarningSchema>;

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
    .enum([
      'proposal_not_found',
      'proposal_rejected',
      'invalid_selection',
      'persistence_failed',
      // An edit the server refused. Separate from `invalid_selection` because
      // the selection was fine and a change to it was not (#164).
      'invalid_edit',
    ])
    .optional(),
  // Optional, not required: it warns rather than refuses (a candidate that
  // collides with nothing sends the same empty array an older server always
  // did), and an older backend that has not shipped this field at all must
  // still parse under this schema.
  collisions: z.array(collisionWarningSchema).optional(),
});

export type CaptureConfirmation = z.infer<typeof captureConfirmationSchema>;

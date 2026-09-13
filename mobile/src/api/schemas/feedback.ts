import { z } from 'zod';
import { isoDateTime } from './common';

const historyRowSchema = z.object({
  id: z.string(),
  outcome: z.string(),
  subjectId: z.string(),
  occurredAt: isoDateTime,
  revokedAt: isoDateTime.nullable(),
  canRevoke: z.boolean(),
});

/**
 * Mirrors `feedback.history.json`.
 *
 * #157's table lists `counters` and `lastUpdatedAt` here. The route does not
 * return them — the fixture is the proof — so the schema does not claim them.
 * Revoked rows stay in `rows`: they are the visible evidence that a correction
 * was applied, and dropping them would ask the user to take our word for it.
 */
/**
 * One answer the user gave to a next step (#170).
 *
 * A separate list from `rows`, not an entry in it: a behaviour row is an
 * observation the system made and offers to revoke, and a decision is a choice
 * the user made with nothing to correct. `decision` is a plain string rather
 * than an enum so a server that learns a sixth answer does not make the whole
 * history unparseable on an older build.
 */
export const nextStepDecisionRowSchema = z.object({
  proposalId: z.string(),
  commitmentId: z.string().nullable(),
  decision: z.string(),
  at: isoDateTime,
  deferUntil: isoDateTime.nullable(),
});

export const feedbackHistorySchema = z.object({
  version: z.string(),
  rows: z.array(historyRowSchema),
  nextStepDecisions: z.array(nextStepDecisionRowSchema).optional(),
  baselineNotice: z
    .object({ countedFrom: isoDateTime.nullable(), note: z.string() })
    .nullable()
    .optional(),
});

export type FeedbackHistoryRow = z.infer<typeof historyRowSchema>;
export type NextStepDecisionRow = z.infer<typeof nextStepDecisionRowSchema>;

export const feedbackRevokeSchema = z.object({
  version: z.string(),
  success: z.boolean(),
  alreadyRevoked: z.boolean(),
  row: historyRowSchema,
});

/** Mirrors `alphaFeedback.flag.json`; the route answers 201. */
export const alphaFeedbackSchema = z.object({
  flagId: z.string(),
  category: z.enum([
    'recommendation_wrong',
    'misunderstood_me',
    'not_useful',
    'invasive',
    'technical_problem',
  ]),
});

export type AlphaFeedbackCategory = z.infer<typeof alphaFeedbackSchema>['category'];
